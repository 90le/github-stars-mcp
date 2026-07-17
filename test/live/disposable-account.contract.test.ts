import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  GitHubPort,
  GitHubUserList,
} from "../../src/app/ports/github-port.js";
import { CredentialProvider } from "../../src/auth/credential-provider.js";
import {
  AppError,
  serializeError,
  type SerializedDomainError,
} from "../../src/domain/errors.js";
import { newOperationId } from "../../src/domain/ids.js";
import type { UserListId } from "../../src/domain/ids.js";
import { createOctokitTransport } from "../../src/github/octokit-client.js";
import { OctokitGitHubAdapter } from "../../src/github/octokit-github-adapter.js";
import { RateGate } from "../../src/github/rate-gate.js";
import { PACKAGE_VERSION } from "../../src/version.js";
import { loadLiveContractConfig } from "../fixtures/live-contract.js";

type CleanupRecord = Readonly<{
  action: string;
  status: "succeeded" | "skipped" | "failed";
  error?: SerializedDomainError;
}>;

type LiveReport = Readonly<{
  schemaVersion: "1";
  status: "passed" | "failed";
  fixture: Readonly<{ login: string; repository: string }>;
  observations: Readonly<{
    listDeletionChangedStarState: boolean | null;
    unstarChangedMembershipState: boolean | null;
  }>;
  cleanup: readonly CleanupRecord[];
  error: SerializedDomainError | null;
}>;

function sameIds(
  left: readonly UserListId[],
  right: readonly UserListId[],
): boolean {
  const normalizedLeft = [...left].map(String).sort();
  const normalizedRight = [...right].map(String).sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function withList(
  listIds: readonly UserListId[],
  listId: UserListId,
): readonly UserListId[] {
  return Object.freeze(
    [
      ...new Map(
        [...listIds, listId].map((value) => [String(value), value]),
      ).values(),
    ].sort((left, right) => String(left).localeCompare(String(right), "en")),
  );
}

async function createLiveAdapter(): Promise<GitHubPort> {
  const credential = await new CredentialProvider({
    host: "github.com",
    authMode: "auto",
  }).resolve();
  return new OctokitGitHubAdapter(
    createOctokitTransport(credential, PACKAGE_VERSION, new RateGate()),
  );
}

function fixtureCoordinates(repository: string): {
  readonly owner: string;
  readonly name: string;
} {
  const separator = repository.indexOf("/");
  if (
    separator <= 0 ||
    separator !== repository.lastIndexOf("/") ||
    separator === repository.length - 1
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Live fixture repository is invalid",
      { retryable: false },
    );
  }
  return Object.freeze({
    owner: repository.slice(0, separator),
    name: repository.slice(separator + 1),
  });
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new AppError("INTERNAL_ERROR", "Live contract failed", {
        retryable: false,
      });
}

describe.skipIf(process.env.GITHUB_STARS_MCP_LIVE !== "1")(
  "disposable GitHub account contract",
  () => {
    it("observes Star and User List independence and always restores state", async () => {
      const config = loadLiveContractConfig();
      const github = await createLiveAdapter();
      const repository = fixtureCoordinates(config.repository);
      const cleanup: CleanupRecord[] = [];
      const cleanupFailures: unknown[] = [];
      let primaryError: unknown;
      let originalStarred: boolean | null = null;
      let originalListIds: readonly UserListId[] | null = null;
      let createdList: GitHubUserList | null = null;
      let createdListDeleted = false;
      let listDeletionChangedStarState: boolean | null = null;
      let unstarChangedMembershipState: boolean | null = null;
      let terminalError: Error | null = null;

      const cleanupAction = async (
        action: string,
        required: boolean,
        callback: () => Promise<void>,
      ): Promise<void> => {
        if (!required) {
          cleanup.push(Object.freeze({ action, status: "skipped" }));
          return;
        }
        try {
          await callback();
          cleanup.push(Object.freeze({ action, status: "succeeded" }));
        } catch (error) {
          cleanupFailures.push(error);
          cleanup.push(
            Object.freeze({
              action,
              status: "failed",
              error: serializeError(error),
            }),
          );
        }
      };

      try {
        const viewer = await github.getViewer();
        expect(viewer.login).toBe(config.login);

        const identity = await github.getRepositoryIdentity(repository);
        if (identity === null) {
          throw new AppError(
            "NOT_FOUND",
            "Live fixture repository was not found",
            {
              retryable: false,
            },
          );
        }

        originalStarred = await github.checkStar(repository);
        originalListIds = await github.getRepositoryListIds(
          identity.repositoryId,
        );
        if (!originalStarred) {
          await github.star(repository, newOperationId());
        }

        const listName = `github-stars-mcp-live-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const created = await github.createUserList(
          {
            name: listName,
            description: "Disposable github-stars-mcp live contract fixture",
            isPrivate: true,
          },
          newOperationId(),
        );
        createdList = created.list;
        expect(createdList.name).toBe(listName);
        expect(createdList.isPrivate).toBe(true);

        const membershipUnderTest = withList(
          originalListIds,
          createdList.listId,
        );
        await github.setRepositoryListIds(
          identity.repositoryId,
          membershipUnderTest,
          newOperationId(),
        );

        await github.unstar(repository, newOperationId());
        const membershipsAfterUnstar = await github.getRepositoryListIds(
          identity.repositoryId,
        );
        unstarChangedMembershipState = !sameIds(
          membershipsAfterUnstar,
          membershipUnderTest,
        );

        await github.star(repository, newOperationId());
        await github.setRepositoryListIds(
          identity.repositoryId,
          membershipUnderTest,
          newOperationId(),
        );
        const starBeforeListDeletion = await github.checkStar(repository);
        await github.deleteUserList(createdList.listId, newOperationId());
        createdListDeleted = true;
        const starAfterListDeletion = await github.checkStar(repository);
        listDeletionChangedStarState =
          starBeforeListDeletion !== starAfterListDeletion;
        expect(starAfterListDeletion).toBe(starBeforeListDeletion);
      } catch (error) {
        primaryError = error;
      } finally {
        const identity = await github
          .getRepositoryIdentity(repository)
          .catch((error: unknown) => {
            cleanupFailures.push(error);
            return null;
          });

        await cleanupAction(
          "ensure fixture is starred for membership restoration",
          identity !== null && originalListIds !== null,
          async () => {
            if (!(await github.checkStar(repository))) {
              await github.star(repository, newOperationId());
            }
          },
        );
        await cleanupAction(
          "restore original User List memberships",
          identity !== null && originalListIds !== null,
          async () => {
            if (identity === null || originalListIds === null) return;
            await github.setRepositoryListIds(
              identity.repositoryId,
              originalListIds,
              newOperationId(),
            );
          },
        );
        await cleanupAction(
          "delete the disposable User List",
          createdList !== null && !createdListDeleted,
          async () => {
            if (createdList === null) return;
            await github.deleteUserList(createdList.listId, newOperationId());
            createdListDeleted = true;
          },
        );
        await cleanupAction(
          "restore original Star state",
          originalStarred !== null,
          async () => {
            if (originalStarred === null) return;
            const current = await github.checkStar(repository);
            if (current === originalStarred) return;
            if (originalStarred) {
              await github.star(repository, newOperationId());
            } else {
              await github.unstar(repository, newOperationId());
            }
          },
        );

        const report: LiveReport = Object.freeze({
          schemaVersion: "1",
          status:
            primaryError === undefined && cleanupFailures.length === 0
              ? "passed"
              : "failed",
          fixture: Object.freeze({
            login: config.login,
            repository: config.repository,
          }),
          observations: Object.freeze({
            listDeletionChangedStarState,
            unstarChangedMembershipState,
          }),
          cleanup: Object.freeze([...cleanup]),
          error:
            primaryError === undefined ? null : serializeError(primaryError),
        });

        try {
          await mkdir(dirname(config.reportPath), { recursive: true });
          await writeFile(
            config.reportPath,
            `${JSON.stringify(report, null, 2)}\n`,
            "utf8",
          );
        } catch (error) {
          cleanupFailures.push(error);
        }

        if (cleanupFailures.length > 0) {
          terminalError = new AggregateError(
            primaryError === undefined
              ? cleanupFailures.map(asError)
              : [asError(primaryError), ...cleanupFailures.map(asError)],
            "Disposable-account live contract or cleanup failed",
          );
        } else if (primaryError !== undefined) {
          terminalError = asError(primaryError);
        }
      }

      if (terminalError !== null) throw terminalError;
    });
  },
);
