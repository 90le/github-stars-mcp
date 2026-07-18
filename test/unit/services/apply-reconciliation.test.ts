import { describe, expect, it } from "vitest";
import type {
  GitHubLiveReadPort,
  GitHubMutationPort,
  MutationReceipt,
  Page,
  RepositoryIdentity,
  UserListMutationResult,
} from "../../../src/app/ports/github-port.js";
import {
  MutationExecutor,
  type ExecutionContext,
} from "../../../src/app/services/mutation-executor.js";
import {
  reconcileOperation,
  type ReconciliationDecision,
} from "../../../src/app/services/reconciliation.js";
import {
  asRepositoryDatabaseId,
  asRepositoryId,
  asUserListId,
  type UserListId,
} from "../../../src/domain/ids.js";
import {
  parseResolvedOperation,
  type ResolvedOperation,
} from "../../../src/domain/plan.js";
import type { UserList } from "../../../src/domain/repository.js";
import {
  repositoryFixture,
  userListFixture,
} from "../../support/change-service-fixtures.js";

const repository = repositoryFixture({
  repositoryId: asRepositoryId("R_reconcile"),
  repositoryDatabaseId: asRepositoryDatabaseId("7001"),
  owner: "example",
  name: "reconcile",
  fullName: "example/reconcile",
  url: "https://github.com/example/reconcile",
});
const coordinates = Object.freeze({
  owner: repository.owner,
  name: repository.name,
});
const identity = Object.freeze({
  repositoryId: repository.repositoryId,
  repositoryDatabaseId: repository.repositoryDatabaseId,
  coordinates,
});
const beforeList = userListFixture({
  listId: asUserListId("UL_before"),
  name: "Before",
  slug: "before",
  description: "before description",
  isPrivate: false,
});
const afterList = userListFixture({
  ...beforeList,
  name: "After",
  slug: "after",
  description: "after description",
  isPrivate: true,
});
const membershipTargetList = userListFixture({
  listId: asUserListId("UL_membership_target"),
  name: "Membership target",
  slug: "membership-target",
});
const existingList = userListFixture({
  listId: asUserListId("UL_existing"),
  name: "Existing",
  slug: "existing",
});
const createdList = userListFixture({
  listId: asUserListId("UL_created"),
  name: "Desired",
  slug: "desired",
  description: "created by the plan",
  isPrivate: true,
});

function completeList(list: UserList) {
  return Object.freeze({
    listId: list.listId,
    name: list.name,
    slug: list.slug,
    description: list.description,
    isPrivate: list.isPrivate,
    createdAt: list.createdAt,
    updatedAt: list.updatedAt,
    lastAddedAt: list.lastAddedAt,
  });
}

function repositoryFields() {
  return {
    repositoryId: repository.repositoryId,
    repositoryDatabaseId: repository.repositoryDatabaseId,
    coordinates,
  } as const;
}

function starOperation(kind: "star" | "unstar"): ResolvedOperation {
  return parseResolvedOperation(
    kind === "star"
      ? {
          operationId: "op_star",
          kind,
          ...repositoryFields(),
          dependsOn: [],
          preconditions: [{ kind: "star_state", expected: false }],
          before: { starred: false },
          after: { starred: true },
          inverse: { kind: "unstar" },
          risk: "normal",
        }
      : {
          operationId: "op_unstar",
          kind,
          ...repositoryFields(),
          dependsOn: [],
          preconditions: [{ kind: "star_state", expected: true }],
          before: {
            starred: true,
            starredAt: "2026-07-16T00:00:00.000Z",
            listIds: [],
          },
          after: { starred: false },
          inverse: { kind: "star", listIds: [] },
          risk: "non_reversible",
        },
  );
}

function updateOperation(): ResolvedOperation {
  const before = {
    name: beforeList.name,
    description: beforeList.description,
    isPrivate: beforeList.isPrivate,
  } as const;
  const after = {
    name: afterList.name,
    description: afterList.description,
    isPrivate: afterList.isPrivate,
  } as const;
  return parseResolvedOperation({
    operationId: "op_update",
    kind: "list_update",
    listId: beforeList.listId,
    dependsOn: [],
    preconditions: [{ kind: "list_metadata", expected: before }],
    before,
    after,
    inverse: { kind: "list_update", ...before },
    risk: "normal",
  });
}

function deleteOperation(): ResolvedOperation {
  const list = completeList(beforeList);
  return parseResolvedOperation({
    operationId: "op_delete",
    kind: "list_delete",
    listId: beforeList.listId,
    dependsOn: [],
    preconditions: [{ kind: "list_metadata", expected: list }],
    before: { list, repositoryIds: [repository.repositoryId] },
    after: { exists: false },
    inverse: {
      kind: "list_create",
      list,
      repositoryIds: [repository.repositoryId],
    },
    risk: "destructive",
  });
}

function membershipOperation(): ResolvedOperation {
  return parseResolvedOperation({
    operationId: "op_membership",
    kind: "list_membership_set",
    ...repositoryFields(),
    expectedListIds: [beforeList.listId],
    targetLists: [{ kind: "existing", listId: membershipTargetList.listId }],
    dependsOn: [],
    preconditions: [
      {
        kind: "list_memberships",
        expected: { listIds: [beforeList.listId] },
      },
    ],
    before: { listIds: [beforeList.listId] },
    after: { listIds: [membershipTargetList.listId] },
    inverse: {
      kind: "list_membership_set",
      listIds: [beforeList.listId],
    },
    risk: "normal",
  });
}

function createOperation(): ResolvedOperation {
  return parseResolvedOperation({
    operationId: "op_create",
    kind: "list_create",
    clientRef: "desired",
    dependsOn: [],
    preconditions: [
      {
        kind: "list_id_baseline",
        expected: { listIds: [existingList.listId] },
      },
    ],
    before: { listIds: [existingList.listId] },
    after: {
      name: createdList.name,
      description: createdList.description,
      isPrivate: createdList.isPrivate,
    },
    inverse: { kind: "list_delete" },
    risk: "normal",
  });
}

class ReconciliationGitHub implements GitHubLiveReadPort, GitHubMutationPort {
  repositoryIdentity: RepositoryIdentity | null = identity;
  starred = false;
  list: UserList | null = null;
  repositoryListIds: readonly UserListId[] = [];
  listPages: readonly (readonly UserList[])[] = [[]];
  mutationCalls = 0;
  readFailure: Error | null = null;

  #read<T>(value: T): Promise<T> {
    return this.readFailure === null
      ? Promise.resolve(value)
      : Promise.reject(this.readFailure);
  }

  getRepositoryIdentity(): Promise<RepositoryIdentity | null> {
    return this.#read(this.repositoryIdentity);
  }

  getUserList(): Promise<UserList | null> {
    return this.#read(this.list);
  }

  checkStar(): Promise<boolean> {
    return this.#read(this.starred);
  }

  getRepositoryListIds(): Promise<readonly UserListId[]> {
    return this.#read(this.repositoryListIds);
  }

  listUserLists(cursor: string | null): Promise<Page<UserList>> {
    const index = cursor === null ? 0 : Number(cursor.slice("page:".length));
    const items = this.listPages[index] ?? [];
    const nextCursor =
      index + 1 < this.listPages.length ? `page:${String(index + 1)}` : null;
    return this.#read(
      Object.freeze({
        items,
        nextCursor,
        rateLimit: null,
        warnings: Object.freeze([]),
      }),
    );
  }

  #mutation(): Error {
    this.mutationCalls += 1;
    return new Error("reconciliation must not mutate");
  }

  star(): Promise<MutationReceipt> {
    return Promise.reject(this.#mutation());
  }

  unstar(): Promise<MutationReceipt> {
    return Promise.reject(this.#mutation());
  }

  createUserList(): Promise<UserListMutationResult> {
    return Promise.reject(this.#mutation());
  }

  updateUserList(): Promise<UserListMutationResult> {
    return Promise.reject(this.#mutation());
  }

  deleteUserList(): Promise<MutationReceipt> {
    return Promise.reject(this.#mutation());
  }

  setRepositoryListIds(): Promise<MutationReceipt> {
    return Promise.reject(this.#mutation());
  }
}

function fixture() {
  const github = new ReconciliationGitHub();
  const context: ExecutionContext = {
    createdListIdsByOperationId: new Map(),
  };
  return {
    github,
    context,
    executor: new MutationExecutor(github, github),
  };
}

async function decision(
  operation: ResolvedOperation,
  configure: (github: ReconciliationGitHub) => void,
): Promise<ReconciliationDecision> {
  const current = fixture();
  configure(current.github);
  const result = await reconcileOperation(
    current.executor,
    operation,
    current.context,
  );
  expect(current.github.mutationCalls).toBe(0);
  return result;
}

describe("reconcileOperation", () => {
  it.each([
    ["star", starOperation("star"), false, "confirmed_not_applied"],
    ["star", starOperation("star"), true, "confirmed_applied"],
    ["unstar", starOperation("unstar"), true, "confirmed_not_applied"],
    ["unstar", starOperation("unstar"), false, "confirmed_applied"],
  ] as const)(
    "classifies %s from exact stable Star state",
    async (_label, operation, starred, expected) => {
      const result = await decision(operation, (github) => {
        github.starred = starred;
      });
      expect(result.kind).toBe(expected);
      expect(result.state).toEqual({ starred });
    },
  );

  it.each([starOperation("star"), starOperation("unstar")])(
    "returns unknown for a missing or mismatched repository identity",
    async (operation) => {
      const result = await decision(operation, (github) => {
        github.repositoryIdentity = null;
      });
      expect(result.kind).toBe("unknown");
    },
  );

  it.each([
    [afterList, "confirmed_applied"],
    [beforeList, "confirmed_not_applied"],
    [
      userListFixture({
        ...beforeList,
        name: "Third state",
        slug: "third-state",
      }),
      "unknown",
    ],
    [null, "unknown"],
  ] as const)("classifies List update metadata %#", async (list, expected) => {
    const result = await decision(updateOperation(), (github) => {
      github.list = list;
    });
    expect(result.kind).toBe(expected);
  });

  it.each([
    [null, "confirmed_applied"],
    [beforeList, "confirmed_not_applied"],
    [afterList, "unknown"],
  ] as const)("classifies List deletion %#", async (list, expected) => {
    const result = await decision(deleteOperation(), (github) => {
      github.list = list;
    });
    expect(result.kind).toBe(expected);
  });

  it.each([
    [[membershipTargetList.listId], "confirmed_applied"],
    [[beforeList.listId], "confirmed_not_applied"],
    [[beforeList.listId, membershipTargetList.listId], "unknown"],
  ] as const)(
    "classifies complete membership state %#",
    async (listIds, expected) => {
      const result = await decision(membershipOperation(), (github) => {
        github.repositoryListIds = listIds;
      });
      expect(result.kind).toBe(expected);
    },
  );

  it("finds exactly one newly created exact-metadata List across all pages", async () => {
    const current = fixture();
    const oldSameName = userListFixture({
      ...createdList,
      listId: existingList.listId,
    });
    current.github.listPages = [
      [oldSameName],
      [
        userListFixture({
          listId: asUserListId("UL_other"),
          name: "Other",
          slug: "other",
        }),
        createdList,
      ],
    ];

    const result = await reconcileOperation(
      current.executor,
      createOperation(),
      current.context,
    );

    expect(result.kind).toBe("confirmed_applied");
    expect(current.context.createdListIdsByOperationId.get("op_create")).toBe(
      createdList.listId,
    );
    expect(current.github.mutationCalls).toBe(0);
  });

  it("returns unknown for duplicate List IDs across exhaustive pages", async () => {
    const current = fixture();
    current.github.listPages = [[createdList], [createdList]];
    const result = await reconcileOperation(
      current.executor,
      createOperation(),
      current.context,
    );
    expect(result.kind).toBe("unknown");
    expect(current.context.createdListIdsByOperationId.size).toBe(0);
  });

  it("returns unknown for a cursor cycle without dispatching", async () => {
    const current = fixture();
    current.github.listUserLists = () =>
      Promise.resolve(
        Object.freeze({
          items: Object.freeze([]),
          nextCursor: "cycle",
          rateLimit: null,
          warnings: Object.freeze([]),
        }),
      );
    const result = await reconcileOperation(
      current.executor,
      createOperation(),
      current.context,
    );
    expect(result.kind).toBe("unknown");
    expect(current.github.mutationCalls).toBe(0);
  });

  it("returns unknown when exhaustive List collection exceeds 5,000 IDs", async () => {
    const current = fixture();
    current.github.listPages = Array.from({ length: 51 }, (_, page) =>
      Object.freeze(
        Array.from({ length: 100 }, (_unused, item) =>
          userListFixture({
            listId: asUserListId(`UL_${String(page)}_${String(item)}`),
            name: `List ${String(page)} ${String(item)}`,
            slug: `list-${String(page)}-${String(item)}`,
          }),
        ),
      ),
    );
    const result = await reconcileOperation(
      current.executor,
      createOperation(),
      current.context,
    );
    expect(result.kind).toBe("unknown");
  });

  it("rejects malformed pages without invoking accessor hooks", async () => {
    const current = fixture();
    let getterCalls = 0;
    const hostile = {
      get items(): readonly UserList[] {
        getterCalls += 1;
        throw new Error("raw-page-secret");
      },
      nextCursor: null,
      rateLimit: null,
      warnings: Object.freeze([]),
    };
    current.github.listUserLists = () =>
      Promise.resolve(hostile as Page<UserList>);
    const result = await reconcileOperation(
      current.executor,
      createOperation(),
      current.context,
    );
    expect(result).toMatchObject({
      kind: "unknown",
      state: { reason: "read_failed" },
    });
    expect(getterCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("propagates cancellation instead of converting it to unknown", async () => {
    const current = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      reconcileOperation(
        current.executor,
        createOperation(),
        current.context,
        controller.signal,
      ),
    ).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { reason: "cancelled" },
    });
    expect(current.github.mutationCalls).toBe(0);
  });

  it.each([
    [[], "confirmed_not_applied"],
    [
      [
        createdList,
        userListFixture({
          ...createdList,
          listId: asUserListId("UL_created_duplicate"),
        }),
      ],
      "unknown",
    ],
  ] as const)(
    "classifies created List candidates %#",
    async (lists, expected) => {
      const current = fixture();
      current.github.listPages = [lists];
      const result = await reconcileOperation(
        current.executor,
        createOperation(),
        current.context,
      );
      expect(result.kind).toBe(expected);
      expect(current.github.mutationCalls).toBe(0);
    },
  );

  it.each([
    starOperation("star"),
    starOperation("unstar"),
    updateOperation(),
    deleteOperation(),
    membershipOperation(),
    createOperation(),
  ])(
    "returns unknown rather than dispatching when a named read fails",
    async (operation) => {
      const current = fixture();
      current.github.readFailure = new Error("fixture read unavailable");
      const result = await reconcileOperation(
        current.executor,
        operation,
        current.context,
      );
      expect(result.kind).toBe("unknown");
      expect(current.github.mutationCalls).toBe(0);
    },
  );
});
