import type { GitHubPort } from "./app/ports/github-port.js";
import {
  SystemRuntime,
  type Clock,
  type IdGenerator,
} from "./app/ports/runtime-port.js";
import type { StoragePort } from "./app/ports/storage-port.js";
import { ApplyService } from "./app/services/apply-service.js";
import { DiscoveryService } from "./app/services/discovery-service.js";
import { EvidenceService } from "./app/services/evidence-service.js";
import { InspectService } from "./app/services/inspect-service.js";
import { ListsQueryService } from "./app/services/lists-query-service.js";
import { MutationExecutor } from "./app/services/mutation-executor.js";
import { MutationPacer } from "./app/services/mutation-pacer.js";
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
) => Promise<GitHubSession>;

export type ServiceFactoryOptions = Readonly<{
  runtime?: Clock & IdGenerator;
  rateGate?: RateGate;
  sessionFactory?: GitHubSessionFactory;
  instanceId?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
}>;

async function createGitHubSession(
  config: AppConfig,
  env: Readonly<NodeJS.ProcessEnv>,
  rateGate: RateGate,
): Promise<GitHubSession> {
  const credential = await new CredentialProvider(
    config,
    undefined,
    env,
  ).resolve();
  const github = new OctokitGitHubAdapter(
    createOctokitTransport(credential, PACKAGE_VERSION, rateGate),
  );
  const binding = await github.getViewer();
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
