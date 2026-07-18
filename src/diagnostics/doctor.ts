import { execFile } from "node:child_process";
import type { GitHubCapabilities } from "../app/ports/github-port.js";
import { SystemRuntime } from "../app/ports/runtime-port.js";
import { CredentialProvider } from "../auth/credential-provider.js";
import type { AppConfig } from "../config.js";
import { createOctokitTransport } from "../github/octokit-client.js";
import { OctokitGitHubAdapter } from "../github/octokit-github-adapter.js";
import { RateGate } from "../github/rate-gate.js";
import { SQLiteStore } from "../storage/sqlite-store.js";
import { PACKAGE_VERSION } from "../version.js";

export type DoctorCheckName =
  | "runtime"
  | "database"
  | "gh"
  | "credentials"
  | "network"
  | "capabilities";

export type DoctorCheck = Readonly<{
  name: DoctorCheckName;
  status: "pass" | "degraded" | "fail";
  message: string;
}>;

export type DoctorReport = Readonly<{
  status: "healthy" | "degraded" | "unusable";
  checks: readonly DoctorCheck[];
}>;

export type DoctorDependencies = Readonly<{
  checkRuntime(): Promise<void>;
  checkDatabase(): Promise<void>;
  checkGh(): Promise<boolean>;
  checkCredentials(): Promise<void>;
  checkNetwork(): Promise<void>;
  checkCapabilities(): Promise<GitHubCapabilities>;
}>;

const CHECK_MESSAGES = Object.freeze({
  runtime: Object.freeze({
    pass: "Node.js runtime is supported.",
    fail: "Node.js 22 or newer is required.",
  }),
  database: Object.freeze({
    pass: "The local state database is usable.",
    fail: "The local state database is unusable.",
  }),
  gh: Object.freeze({
    pass: "GitHub CLI is available.",
    degraded: "GitHub CLI is unavailable; environment authentication may work.",
  }),
  credentials: Object.freeze({
    pass: "GitHub credentials are available.",
    fail: "GitHub credentials are unavailable.",
  }),
  network: Object.freeze({
    pass: "GitHub identity is reachable.",
    fail: "GitHub identity could not be verified.",
  }),
  capabilities: Object.freeze({
    pass: "GitHub Stars and User Lists are available.",
    degraded:
      "Core access works, but one or more optional write or List capabilities are unavailable.",
    fail: "GitHub Stars read access is unavailable.",
  }),
});

function check(
  name: DoctorCheckName,
  status: DoctorCheck["status"],
  message: string,
): DoctorCheck {
  return Object.freeze({ name, status, message });
}

async function simpleCheck(
  name: "runtime" | "database" | "credentials" | "network",
  probe: () => Promise<void>,
): Promise<DoctorCheck> {
  try {
    await probe();
    return check(name, "pass", CHECK_MESSAGES[name].pass);
  } catch {
    return check(name, "fail", CHECK_MESSAGES[name].fail);
  }
}

function capabilityCheck(capabilities: GitHubCapabilities): DoctorCheck {
  if (capabilities.starRead !== "available") {
    return check("capabilities", "fail", CHECK_MESSAGES.capabilities.fail);
  }
  if (
    capabilities.starWrite === "unavailable" ||
    capabilities.listRead !== "available" ||
    capabilities.listWrite === "unavailable"
  ) {
    return check(
      "capabilities",
      "degraded",
      CHECK_MESSAGES.capabilities.degraded,
    );
  }
  return check("capabilities", "pass", CHECK_MESSAGES.capabilities.pass);
}

export async function runDoctor(
  dependencies: DoctorDependencies,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(
    await simpleCheck("runtime", dependencies.checkRuntime),
    await simpleCheck("database", dependencies.checkDatabase),
  );

  try {
    const available = await dependencies.checkGh();
    checks.push(
      available
        ? check("gh", "pass", CHECK_MESSAGES.gh.pass)
        : check("gh", "degraded", CHECK_MESSAGES.gh.degraded),
    );
  } catch {
    checks.push(check("gh", "degraded", CHECK_MESSAGES.gh.degraded));
  }

  checks.push(
    await simpleCheck("credentials", dependencies.checkCredentials),
    await simpleCheck("network", dependencies.checkNetwork),
  );
  try {
    checks.push(capabilityCheck(await dependencies.checkCapabilities()));
  } catch {
    checks.push(
      check("capabilities", "fail", CHECK_MESSAGES.capabilities.fail),
    );
  }

  const status = checks.some((candidate) => candidate.status === "fail")
    ? "unusable"
    : checks.some((candidate) => candidate.status === "degraded")
      ? "degraded"
      : "healthy";
  return Object.freeze({ status, checks: Object.freeze(checks) });
}

export function doctorExitCode(report: DoctorReport): 0 | 1 | 2 {
  return report.status === "healthy" ? 0 : report.status === "degraded" ? 2 : 1;
}

function checkNodeVersion(): Promise<void> {
  const match = /^(\d+)\./u.exec(process.versions.node);
  if (match === null || Number(match[1]) < 22) {
    return Promise.reject(new Error("unsupported runtime"));
  }
  return Promise.resolve();
}

function checkGitHubCli(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(
        "gh",
        ["--version"],
        {
          encoding: "utf8",
          maxBuffer: 64 * 1024,
          shell: false,
          timeout: 5_000,
          windowsHide: true,
        },
        (error) => resolve(error === null),
      );
    } catch {
      resolve(false);
    }
  });
}

export function createDoctorDependencies(
  config: AppConfig,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): DoctorDependencies {
  const runtime = new SystemRuntime();
  const credentialProvider = new CredentialProvider(config, undefined, env);
  const rateGate = new RateGate();
  let credentialPromise: ReturnType<CredentialProvider["resolve"]> | undefined;
  let adapterPromise: Promise<OctokitGitHubAdapter> | undefined;

  const credential = () => {
    credentialPromise ??= credentialProvider.resolve();
    return credentialPromise;
  };
  const adapter = () => {
    adapterPromise ??= credential().then(
      (resolved) =>
        new OctokitGitHubAdapter(
          createOctokitTransport(resolved, PACKAGE_VERSION, rateGate),
        ),
    );
    return adapterPromise;
  };

  return Object.freeze({
    checkRuntime: checkNodeVersion,
    checkDatabase(): Promise<void> {
      const store = new SQLiteStore(config.dataDir, runtime);
      try {
        store.migrate();
        if (store.getSchemaVersion() < 1) {
          throw new Error("missing database schema");
        }
      } finally {
        store.close();
      }
      return Promise.resolve();
    },
    checkGh: checkGitHubCli,
    async checkCredentials(): Promise<void> {
      await credential();
    },
    async checkNetwork(): Promise<void> {
      await (await adapter()).getViewer();
    },
    async checkCapabilities(): Promise<GitHubCapabilities> {
      return (await adapter()).probeCapabilities();
    },
  });
}
