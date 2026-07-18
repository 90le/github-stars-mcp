import type { GitHubPort } from "./app/ports/github-port.js";
import {
  SystemRuntime,
  type Clock,
  type IdGenerator,
} from "./app/ports/runtime-port.js";
import type { StoragePort } from "./app/ports/storage-port.js";
import { ApplyService } from "./app/services/apply-service.js";
import { DiscoveryService } from "./app/services/discovery-service.js";
import { CandidateQueryService } from "./app/services/candidate-query-service.js";
import { EvidenceService } from "./app/services/evidence-service.js";
import { InspectService } from "./app/services/inspect-service.js";
import { ListsQueryService } from "./app/services/lists-query-service.js";
import { MutationExecutor } from "./app/services/mutation-executor.js";
import { MutationPacer } from "./app/services/mutation-pacer.js";
import { OperationCoordinator } from "./app/services/operation-coordinator.js";
import { PlanService } from "./app/services/plan-service.js";
import { QueryService } from "./app/services/query-service.js";
import { RollbackService } from "./app/services/rollback-service.js";
import type { ServiceRegistry } from "./app/services/service-registry.js";
import { StatusService } from "./app/services/status-service.js";
import { SyncService } from "./app/services/sync-service.js";
import {
  CredentialProvider,
  type CredentialSource,
} from "./auth/credential-provider.js";
import type { AppConfig } from "./config.js";
import type { AccountBinding } from "./domain/repository.js";
import { createOctokitTransport } from "./github/octokit-client.js";
import { OctokitGitHubAdapter } from "./github/octokit-github-adapter.js";
import { RateGate } from "./github/rate-gate.js";
import {
  StderrLogger,
  safeErrorMessage,
  type LogSink,
} from "./logging/stderr-logger.js";
import { createMcpServer } from "./mcp/create-server.js";
import { SQLiteStore } from "./storage/sqlite-store.js";
import { PACKAGE_VERSION } from "./version.js";

export type GitHubSession = Readonly<{
  github: GitHubPort;
  credentialSource: CredentialSource;
  binding: AccountBinding;
}>;

export type GitHubSessionFactory = (
  config: AppConfig,
  env: Readonly<NodeJS.ProcessEnv>,
  rateGate: RateGate,
  signal?: AbortSignal,
) => Promise<GitHubSession>;

export type ServiceFactoryOptions = Readonly<{
  runtime?: Clock & IdGenerator;
  rateGate?: RateGate;
  sessionFactory?: GitHubSessionFactory;
  instanceId?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  signal?: AbortSignal;
}>;

async function createGitHubSession(
  config: AppConfig,
  env: Readonly<NodeJS.ProcessEnv>,
  rateGate: RateGate,
  signal?: AbortSignal,
): Promise<GitHubSession> {
  const credential = await new CredentialProvider(
    config,
    undefined,
    env,
  ).resolve();
  const github = new OctokitGitHubAdapter(
    createOctokitTransport(credential, PACKAGE_VERSION, rateGate),
  );
  const binding = await github.getViewer(signal);
  return Object.freeze({
    github,
    credentialSource: credential.source,
    binding,
  });
}

export async function createServices(
  config: AppConfig,
  storage: StoragePort,
  options: ServiceFactoryOptions = {},
): Promise<ServiceRegistry> {
  const runtime = options.runtime ?? new SystemRuntime();
  const rateGate = options.rateGate ?? new RateGate();
  const session = await (options.sessionFactory ?? createGitHubSession)(
    config,
    options.env ?? process.env,
    rateGate,
    options.signal,
  );
  const evidence = new EvidenceService(
    session.github,
    config.maxReadConcurrency,
  );
  const executor = new MutationExecutor(session.github, session.github);
  const pacer = new MutationPacer(undefined, config.writeIntervalMs);
  const instanceId = options.instanceId ?? `process:${runtime.requestId()}`;

  return Object.freeze({
    clock: runtime,
    status: new StatusService(
      session.github,
      storage,
      session.credentialSource,
      rateGate,
    ),
    sync: new SyncService(session.github, storage, runtime, rateGate),
    query: new QueryService(storage, session.binding, evidence),
    listsQuery: new ListsQueryService(storage, session.binding),
    discover: new DiscoveryService(
      session.github,
      storage,
      session.binding,
      evidence,
    ),
    candidates: new CandidateQueryService(storage, session.binding),
    plan: new PlanService(storage, runtime, config),
    inspect: new InspectService(storage),
    apply: new ApplyService({
      github: session.github,
      storage,
      runtime,
      executor,
      pacer,
      config,
      instanceId,
    }),
    rollback: new RollbackService(storage, runtime, config),
  });
}

export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): void;
  off(signal: NodeJS.Signals, listener: () => void): void;
}

type ServerDependencies = Readonly<{
  runtime?: Clock & IdGenerator;
  signalSource?: SignalSource;
  storeFactory?: (
    dataDirectory: string,
    runtime: Clock & IdGenerator,
  ) => StoragePort;
  serviceFactory?: typeof createServices;
  serverFactory?: (
    services: ServiceRegistry,
    coordinator: OperationCoordinator,
  ) => McpServer;
  transportFactory?: (input: Readable, output: Writable) => Transport;
  coordinatorFactory?: () => OperationCoordinator;
}>;

export type RunServerOptions = Readonly<{
  config: AppConfig;
  env?: Readonly<NodeJS.ProcessEnv>;
  input?: Readable;
  output?: Writable;
  loggerSink?: LogSink;
  dependencies?: ServerDependencies;
}>;

export async function runServer(options: RunServerOptions): Promise<void> {
  const dependencies = options.dependencies ?? {};
  const runtime = dependencies.runtime ?? new SystemRuntime();
  const coordinator =
    dependencies.coordinatorFactory?.() ?? new OperationCoordinator();
  const signalSource = dependencies.signalSource ?? process;
  const logger = new StderrLogger(
    options.config.logLevel,
    options.loggerSink ?? process.stderr,
  );
  const store = (dependencies.storeFactory ?? defaultStoreFactory)(
    options.config.dataDir,
    runtime,
  );

  let server: McpServer | undefined;
  let serverClosed = false;
  let storeClosed = false;
  let shutdownPromise: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const performShutdown = async (): Promise<void> => {
    coordinator.stopAccepting();
    coordinator.abort();
    await coordinator.drain();

    let closeFailure: unknown;
    if (server !== undefined && !serverClosed) {
      serverClosed = true;
      try {
        await server.close();
      } catch (error) {
        closeFailure = error;
      }
    }
    if (!storeClosed) {
      storeClosed = true;
      try {
        store.close();
      } catch (error) {
        closeFailure ??= error;
      }
    }
    resolveClosed();
    if (closeFailure !== undefined) {
      throw closeFailure instanceof Error
        ? closeFailure
        : new Error("Server shutdown failed", { cause: closeFailure });
    }
  };
  const requestShutdown = (): Promise<void> => {
    shutdownPromise ??= performShutdown();
    return shutdownPromise;
  };
  const onSignal = (): void => {
    void requestShutdown().catch((error: unknown) => {
      logger.error("shutdown_failed", safeErrorMessage(error));
    });
  };

  signalSource.on("SIGINT", onSignal);
  signalSource.on("SIGTERM", onSignal);
  try {
    store.migrate();
    store.recoverIncompleteSnapshots(runtime.now());
    store.recoverInterruptedRuns(runtime.now());

    const services = await coordinator.run((signal) =>
      (dependencies.serviceFactory ?? createServices)(options.config, store, {
        runtime,
        env: options.env ?? process.env,
        signal,
      }),
    );
    if (!coordinator.accepting) {
      await requestShutdown();
      return;
    }
    server = (dependencies.serverFactory ?? createMcpServer)(
      services,
      coordinator,
    );
    server.server.onerror = (error) => {
      logger.error("transport_error", safeErrorMessage(error));
    };
    server.server.onclose = () => {
      void requestShutdown().catch((error: unknown) => {
        logger.error("shutdown_failed", safeErrorMessage(error));
      });
    };

    const transport = (
      dependencies.transportFactory ??
      ((input, output) => new StdioServerTransport(input, output))
    )(options.input ?? process.stdin, options.output ?? process.stdout);
    await server.connect(transport);
    logger.info("server_started", "GitHub Stars MCP server started.");
    await closed;
    await shutdownPromise;
  } catch (error) {
    const shutdownWasAlreadyRequested = shutdownPromise !== undefined;
    try {
      await requestShutdown();
    } catch (shutdownError) {
      logger.error("shutdown_failed", safeErrorMessage(shutdownError));
    }
    if (shutdownWasAlreadyRequested) return;
    throw error;
  } finally {
    signalSource.off("SIGINT", onSignal);
    signalSource.off("SIGTERM", onSignal);
  }
}

function defaultStoreFactory(
  dataDirectory: string,
  runtime: Clock & IdGenerator,
): StoragePort {
  return new SQLiteStore(dataDirectory, runtime);
}
import type { Readable, Writable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
