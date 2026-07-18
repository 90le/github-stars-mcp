import type {
  CreateUserListInput,
  GitHubPort,
  GitHubUserList,
} from "../../src/app/ports/github-port.js";
import { AppError } from "../../src/domain/errors.js";
import type { UserListId } from "../../src/domain/ids.js";

export type LiveContractConfig = Readonly<{
  login: string;
  repository: string;
  reportPath: "artifacts/live-contract.json";
}>;

const LOGIN = /^(?!-)(?!.*-$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const FIXTURE_SUFFIX = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,69})$/u;

export async function verifyCreatedUserListReadback(
  github: Pick<GitHubPort, "getUserList">,
  listId: UserListId,
  expected: CreateUserListInput,
): Promise<GitHubUserList> {
  const observed = await github.getUserList(listId);
  if (
    observed === null ||
    observed.listId !== listId ||
    observed.name !== expected.name ||
    observed.description !== expected.description ||
    observed.isPrivate !== expected.isPrivate
  ) {
    throw new AppError(
      "PRECONDITION_FAILED",
      "Disposable User List creation readback was not exact",
      { retryable: false },
    );
  }
  return observed;
}

function invalidGuard(guard: string): AppError {
  return new AppError(
    "VALIDATION_ERROR",
    "Disposable-account live contract guard is invalid",
    {
      retryable: false,
      details: { guard },
    },
  );
}

function exactEnvironmentValue(
  env: Readonly<NodeJS.ProcessEnv>,
  key: string,
  expected: string,
): void {
  if (env[key] !== expected) throw invalidGuard(key);
}

export function loadLiveContractConfig(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): LiveContractConfig {
  exactEnvironmentValue(env, "GITHUB_STARS_MCP_LIVE", "1");
  exactEnvironmentValue(
    env,
    "GITHUB_STARS_MCP_LIVE_CONFIRM",
    "DELETE_TEST_DATA",
  );

  const login = env.GITHUB_STARS_MCP_LIVE_LOGIN;
  if (typeof login !== "string" || !LOGIN.test(login)) {
    throw invalidGuard("GITHUB_STARS_MCP_LIVE_LOGIN");
  }

  const repository = env.GITHUB_STARS_MCP_LIVE_REPOSITORY;
  const prefix = `${login}/github-stars-mcp-fixture-`;
  if (
    typeof repository !== "string" ||
    !repository.startsWith(prefix) ||
    repository.length > login.length + 1 + 100 ||
    !FIXTURE_SUFFIX.test(repository.slice(prefix.length))
  ) {
    throw invalidGuard("GITHUB_STARS_MCP_LIVE_REPOSITORY");
  }

  return Object.freeze({
    login,
    repository,
    reportPath: "artifacts/live-contract.json",
  });
}
