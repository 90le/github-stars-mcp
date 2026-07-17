import { execFile } from "node:child_process";
import type { AppConfig } from "../config.js";
import { AppError } from "../domain/errors.js";

export type CredentialSource =
  | "GITHUB_STARS_TOKEN"
  | "GITHUB_TOKEN"
  | "GH_TOKEN"
  | "gh";

export type Credential = Readonly<{
  token: string;
  source: CredentialSource;
}>;

export type ExecFileRunner = (
  file: "gh",
  args: readonly ["auth", "token", "--hostname", "github.com"],
) => Promise<Readonly<{ stdout: string }>>;

const GH_ARGUMENTS = Object.freeze([
  "auth",
  "token",
  "--hostname",
  "github.com",
] as const);

const ENVIRONMENT_SOURCES = Object.freeze([
  "GITHUB_STARS_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
] as const);

function authRequired(): AppError {
  return new AppError("AUTH_REQUIRED", "GitHub authentication is required", {
    retryable: false,
  });
}

function invalidConfiguration(message: string): AppError {
  return new AppError("VALIDATION_ERROR", message, { retryable: false });
}

function normalizedToken(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw authRequired();

  const token = value.trim();
  if (token.length === 0) return null;
  for (let index = 0; index < token.length; index += 1) {
    const codeUnit = token.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) throw authRequired();
  }
  return token;
}

function createCredential(
  token: string,
  source: CredentialSource,
): Credential {
  const credential = { source } as {
    token: string;
    source: CredentialSource;
  };
  Object.defineProperty(credential, "token", {
    configurable: false,
    enumerable: false,
    value: token,
    writable: false,
  });
  return Object.freeze(credential);
}

const nativeExecFileRunner: ExecFileRunner = (file, args) =>
  new Promise((resolve, reject) => {
    try {
      execFile(
        file,
        [...args],
        {
          shell: false,
          windowsHide: true,
          encoding: "utf8",
          maxBuffer: 64 * 1024,
        },
        (error, stdout) => {
          if (error !== null || typeof stdout !== "string") {
            reject(new Error("GitHub CLI credential lookup failed"));
            return;
          }
          resolve(Object.freeze({ stdout }));
        },
      );
    } catch {
      reject(new Error("GitHub CLI credential lookup failed"));
    }
  });

export class CredentialProvider {
  readonly #config: Pick<AppConfig, "host" | "authMode">;
  readonly #run: ExecFileRunner;
  readonly #env: Readonly<NodeJS.ProcessEnv>;

  constructor(
    config: Pick<AppConfig, "host" | "authMode">,
    run: ExecFileRunner = nativeExecFileRunner,
    env: Readonly<NodeJS.ProcessEnv> = process.env,
  ) {
    if (config.host !== "github.com") {
      throw invalidConfiguration("GitHub host must be github.com");
    }
    if (
      config.authMode !== "auto" &&
      config.authMode !== "env" &&
      config.authMode !== "gh"
    ) {
      throw invalidConfiguration("GitHub auth mode is invalid");
    }
    this.#config = Object.freeze({
      host: config.host,
      authMode: config.authMode,
    });
    this.#run = run;
    this.#env = env;
  }

  async resolve(): Promise<Credential> {
    if (this.#config.authMode !== "gh") {
      for (const source of ENVIRONMENT_SOURCES) {
        const token = normalizedToken(this.#env[source]);
        if (token !== null) return createCredential(token, source);
      }
      if (this.#config.authMode === "env") throw authRequired();
    }

    try {
      const result = await this.#run("gh", GH_ARGUMENTS);
      const token = normalizedToken(result.stdout);
      if (token === null) throw authRequired();
      return createCredential(token, "gh");
    } catch {
      throw authRequired();
    }
  }
}
