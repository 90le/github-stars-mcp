import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, it } from "vitest";
import type {
  GitHubPort,
  GitHubUserList,
  RepositoryIdentity,
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

function contractFailure(message: string): AppError {
  return new AppError("PRECONDITION_FAILED", message, {
    retryable: false,
  });
}

function sanitizedError(error: unknown): AppError {
  const serialized = serializeError(error);
  return new AppError(serialized.code, serialized.message, {
    retryable: serialized.retryable,
    details: serialized.details,
  });
}

async function listAllUserLists(
  github: Pick<GitHubPort, "listUserLists">,
): Promise<readonly GitHubUserList[]> {
  const lists: GitHubUserList[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
    const page = await github.listUserLists(cursor);
    lists.push(...page.items);
    if (page.nextCursor === null) return Object.freeze(lists);
    if (seenCursors.has(page.nextCursor)) {
      throw contractFailure("Live User List pagination repeated a cursor");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw contractFailure("Live User List pagination exceeded its safety bound");
}

async function deleteUserListAndVerify(
  github: Pick<GitHubPort, "deleteUserList" | "getUserList">,
  listId: UserListId,
): Promise<void> {
  let deletionError: unknown;
  try {
    await github.deleteUserList(listId, newOperationId());
  } catch (error) {
    deletionError = error;
  }
  if ((await github.getUserList(listId)) !== null) {
    throw deletionError === undefined
      ? contractFailure("Cleanup did not delete a disposable User List")
      : sanitizedError(deletionError);
  }
}

function sameIdentity(
  left: RepositoryIdentity,
  right: RepositoryIdentity,
): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.repositoryDatabaseId === right.repositoryDatabaseId &&
    left.coordinates.owner === right.coordinates.owner &&
    left.coordinates.name === right.coordinates.name
  );
}

describe.skipIf(process.env.GITHUB_STARS_MCP_LIVE !== "1")(
  "disposable GitHub account contract",
  () => {
    it("observes Star and User List independence and always restores state", async () => {
      const config = loadLiveContractConfig();
      const repository = fixtureCoordinates(config.repository);
      const cleanup: CleanupRecord[] = [];
      const cleanupFailures: unknown[] = [];
      const verifiedDeletedListIds = new Set<string>();
      let github: GitHubPort | null = null;
      let identity: RepositoryIdentity | null = null;
      let baselineLists: readonly GitHubUserList[] | null = null;
      let primaryError: unknown;
      let originalStarred: boolean | null = null;
      let originalListIds: readonly UserListId[] | null = null;
      let createdList: GitHubUserList | null = null;
      let createdListName: string | null = null;
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
        github = await createLiveAdapter();
        const viewer = await github.getViewer();
        if (viewer.login !== config.login) {
          throw contractFailure("Live viewer does not match the guarded login");
        }

        identity = await github.getRepositoryIdentity(repository);
        if (identity === null) {
          throw new AppError(
            "NOT_FOUND",
            "Live fixture repository was not found",
            { retryable: false },
          );
        }

        originalStarred = await github.checkStar(repository);
        originalListIds = await github.getRepositoryListIds(
          identity.repositoryId,
        );
        baselineLists = await listAllUserLists(github);
        if (!originalStarred) {
          await github.star(repository, newOperationId());
          if (!(await github.checkStar(repository))) {
            throw contractFailure("Live fixture Star setup did not apply");
          }
        }

        createdListName = `github-stars-mcp-live-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const created = await github.createUserList(
          {
            name: createdListName,
            description: "Disposable github-stars-mcp live contract fixture",
            isPrivate: true,
          },
          newOperationId(),
        );
        createdList = created.list;
        if (
          createdList.name !== createdListName ||
          createdList.isPrivate !== true
        ) {
          throw contractFailure("Disposable User List creation was not exact");
        }

        const membershipUnderTest = withList(
          originalListIds,
          createdList.listId,
        );
        await github.setRepositoryListIds(
          identity.repositoryId,
          membershipUnderTest,
          newOperationId(),
        );
        const membershipBeforeUnstar = await github.getRepositoryListIds(
          identity.repositoryId,
        );
        if (!sameIds(membershipBeforeUnstar, membershipUnderTest)) {
          throw contractFailure(
            "Disposable User List membership setup did not apply",
          );
        }

        await github.unstar(repository, newOperationId());
        if (await github.checkStar(repository)) {
          throw contractFailure("Live fixture unstar did not apply");
        }
        const membershipsAfterUnstar = await github.getRepositoryListIds(
          identity.repositoryId,
        );
        unstarChangedMembershipState = !sameIds(
          membershipsAfterUnstar,
          membershipUnderTest,
        );

        await github.star(repository, newOperationId());
        if (!(await github.checkStar(repository))) {
          throw contractFailure("Live fixture restar did not apply");
        }
        await github.setRepositoryListIds(
          identity.repositoryId,
          membershipUnderTest,
          newOperationId(),
        );
        if (
          !sameIds(
            await github.getRepositoryListIds(identity.repositoryId),
            membershipUnderTest,
          )
        ) {
          throw contractFailure(
            "Disposable membership reset before deletion did not apply",
          );
        }

        const starBeforeListDeletion = await github.checkStar(repository);
        await github.deleteUserList(createdList.listId, newOperationId());
        if ((await github.getUserList(createdList.listId)) !== null) {
          throw contractFailure("Disposable User List deletion did not apply");
        }
        verifiedDeletedListIds.add(String(createdList.listId));
        const starAfterListDeletion = await github.checkStar(repository);
        listDeletionChangedStarState =
          starBeforeListDeletion !== starAfterListDeletion;
      } catch (error) {
        primaryError = error;
      } finally {
        const cleanupGithub = github;
        const cleanupIdentity = identity;
        const cleanupOriginalListIds = originalListIds;
        const cleanupOriginalStarred = originalStarred;
        const cleanupBaselineLists = baselineLists;
        const cleanupCreatedListName = createdListName;

        await cleanupAction(
          "revalidate fixture repository identity",
          cleanupGithub !== null && cleanupIdentity !== null,
          async () => {
            if (cleanupGithub === null || cleanupIdentity === null) return;
            const observed =
              await cleanupGithub.getRepositoryIdentity(repository);
            if (observed === null || !sameIdentity(observed, cleanupIdentity)) {
              throw contractFailure(
                "Fixture repository identity changed during the live contract",
              );
            }
          },
        );
        await cleanupAction(
          "ensure fixture is starred for membership restoration",
          cleanupGithub !== null &&
            cleanupIdentity !== null &&
            cleanupOriginalListIds !== null,
          async () => {
            if (cleanupGithub === null) return;
            if (!(await cleanupGithub.checkStar(repository))) {
              await cleanupGithub.star(repository, newOperationId());
            }
            if (!(await cleanupGithub.checkStar(repository))) {
              throw contractFailure(
                "Cleanup could not restore a temporary Star",
              );
            }
          },
        );
        await cleanupAction(
          "restore original User List memberships",
          cleanupGithub !== null &&
            cleanupIdentity !== null &&
            cleanupOriginalListIds !== null,
          async () => {
            if (
              cleanupGithub === null ||
              cleanupIdentity === null ||
              cleanupOriginalListIds === null
            ) {
              return;
            }
            await cleanupGithub.setRepositoryListIds(
              cleanupIdentity.repositoryId,
              cleanupOriginalListIds,
              newOperationId(),
            );
            if (
              !sameIds(
                await cleanupGithub.getRepositoryListIds(
                  cleanupIdentity.repositoryId,
                ),
                cleanupOriginalListIds,
              )
            ) {
              throw contractFailure(
                "Cleanup did not restore original User List memberships",
              );
            }
          },
        );

        const cleanupCandidates = new Map<string, GitHubUserList>();
        if (
          createdList !== null &&
          !verifiedDeletedListIds.has(String(createdList.listId))
        ) {
          cleanupCandidates.set(String(createdList.listId), createdList);
        }
        await cleanupAction(
          "enumerate disposable User Lists",
          cleanupGithub !== null &&
            cleanupBaselineLists !== null &&
            cleanupCreatedListName !== null,
          async () => {
            if (
              cleanupGithub === null ||
              cleanupBaselineLists === null ||
              cleanupCreatedListName === null
            ) {
              return;
            }
            const baselineIds = new Set(
              cleanupBaselineLists.map((list) => String(list.listId)),
            );
            for (const list of await listAllUserLists(cleanupGithub)) {
              if (
                list.name === cleanupCreatedListName &&
                !baselineIds.has(String(list.listId))
              ) {
                cleanupCandidates.set(String(list.listId), list);
              }
            }
          },
        );
        let candidateIndex = 0;
        for (const candidate of cleanupCandidates.values()) {
          candidateIndex += 1;
          await cleanupAction(
            `delete disposable User List ${candidateIndex}`,
            !verifiedDeletedListIds.has(String(candidate.listId)),
            async () => {
              if (cleanupGithub === null) return;
              await deleteUserListAndVerify(cleanupGithub, candidate.listId);
              verifiedDeletedListIds.add(String(candidate.listId));
            },
          );
        }
        await cleanupAction(
          "remove and verify any remaining disposable User Lists",
          cleanupGithub !== null &&
            cleanupBaselineLists !== null &&
            cleanupCreatedListName !== null,
          async () => {
            if (
              cleanupGithub === null ||
              cleanupBaselineLists === null ||
              cleanupCreatedListName === null
            ) {
              return;
            }
            const baselineIds = new Set(
              cleanupBaselineLists.map((list) => String(list.listId)),
            );
            const failures: Error[] = [];
            const remaining = (await listAllUserLists(cleanupGithub)).filter(
              (list) =>
                list.name === cleanupCreatedListName &&
                !baselineIds.has(String(list.listId)),
            );
            for (const list of remaining) {
              try {
                await deleteUserListAndVerify(cleanupGithub, list.listId);
                verifiedDeletedListIds.add(String(list.listId));
              } catch (error) {
                failures.push(sanitizedError(error));
              }
            }
            const stillPresent = (await listAllUserLists(cleanupGithub)).some(
              (list) =>
                list.name === cleanupCreatedListName &&
                !baselineIds.has(String(list.listId)),
            );
            if (failures.length > 0 || stillPresent) {
              if (failures.length > 0) {
                throw new AggregateError(
                  failures,
                  "Disposable User List cleanup failed",
                );
              }
              throw contractFailure(
                "A disposable User List remains after cleanup",
              );
            }
          },
        );
        await cleanupAction(
          "restore original Star state",
          cleanupGithub !== null && cleanupOriginalStarred !== null,
          async () => {
            if (cleanupGithub === null || cleanupOriginalStarred === null) {
              return;
            }
            const current = await cleanupGithub.checkStar(repository);
            if (current !== cleanupOriginalStarred) {
              if (cleanupOriginalStarred) {
                await cleanupGithub.star(repository, newOperationId());
              } else {
                await cleanupGithub.unstar(repository, newOperationId());
              }
            }
            if (
              (await cleanupGithub.checkStar(repository)) !==
              cleanupOriginalStarred
            ) {
              throw contractFailure(
                "Cleanup did not restore the original Star state",
              );
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

        const sanitizedCleanupFailures = cleanupFailures.map(sanitizedError);
        if (sanitizedCleanupFailures.length > 0) {
          terminalError = new AggregateError(
            primaryError === undefined
              ? sanitizedCleanupFailures
              : [sanitizedError(primaryError), ...sanitizedCleanupFailures],
            "Disposable-account live contract or cleanup failed",
          );
        } else if (primaryError !== undefined) {
          terminalError = sanitizedError(primaryError);
        }
      }

      if (terminalError !== null) throw terminalError;
    });
  },
);
