import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type {
  CreateUserListInput,
  GitHubLiveReadPort,
  GitHubMutationPort,
  MutationReceipt,
  RepositoryIdentity,
  UpdateUserListInput,
  UserListMutationResult,
} from "../../../src/app/ports/github-port.js";
import {
  MutationExecutor,
  type ExecutionContext,
  type PreparedMutation,
} from "../../../src/app/services/mutation-executor.js";
import { AppError } from "../../../src/domain/errors.js";
import {
  asRepositoryDatabaseId,
  asRepositoryId,
  asUserListId,
  type RepositoryId,
  type UserListId,
} from "../../../src/domain/ids.js";
import type { ResolvedOperation } from "../../../src/domain/plan.js";
import type {
  RepositoryCoordinates,
  UserList,
} from "../../../src/domain/repository.js";
import { userListFixture } from "../../support/change-service-fixtures.js";

const coordinates = Object.freeze({ owner: "acme", name: "widget" });
const repositoryId = asRepositoryId("R_1");
const repositoryDatabaseId = asRepositoryDatabaseId("101");
const listId = asUserListId("UL_1");
const createdListId = asUserListId("UL_created");

type MutationCall = Readonly<{
  kind:
    | "star"
    | "unstar"
    | "createUserList"
    | "updateUserList"
    | "deleteUserList"
    | "setRepositoryListIds";
  operationId: string;
  value: unknown;
}>;

class StatefulGitHub implements GitHubLiveReadPort, GitHubMutationPort {
  identity: RepositoryIdentity | null = Object.freeze({
    repositoryId,
    repositoryDatabaseId,
    coordinates,
  });
  starred = false;
  applyMutations = true;
  createdList = userListFixture({
    listId: createdListId,
    name: "Created",
    slug: "created",
    description: null,
    isPrivate: false,
  });
  readonly lists = new Map<UserListId, UserList>();
  readonly memberships = new Map<RepositoryId, readonly UserListId[]>();
  readonly reads: string[] = [];
  readonly mutations: MutationCall[] = [];
  onRead: ((name: string) => void) | null = null;
  afterMutation: ((kind: MutationCall["kind"]) => void) | null = null;

  constructor() {
    this.lists.set(
      listId,
      userListFixture({
        listId,
        name: "Original",
        slug: "original",
        description: "Before",
        isPrivate: false,
      }),
    );
    this.memberships.set(repositoryId, Object.freeze([listId]));
  }

  #read(name: string): void {
    this.reads.push(name);
    this.onRead?.(name);
  }

  #record(
    kind: MutationCall["kind"],
    operationId: string,
    value: unknown,
  ): void {
    this.mutations.push(Object.freeze({ kind, operationId, value }));
  }

  #receipt(kind: MutationCall["kind"], operationId: string): MutationReceipt {
    return Object.freeze({
      requestId: `REQ-${String(this.mutations.length)}`,
      clientMutationId:
        kind === "star" || kind === "unstar" ? null : operationId,
    });
  }

  getRepositoryIdentity(): Promise<RepositoryIdentity | null> {
    this.#read("getRepositoryIdentity");
    return Promise.resolve(this.identity);
  }

  getUserList(id: UserListId): Promise<UserList | null> {
    this.#read(`getUserList:${id}`);
    return Promise.resolve(this.lists.get(id) ?? null);
  }

  checkStar(): Promise<boolean> {
    this.#read("checkStar");
    return Promise.resolve(this.starred);
  }

  getRepositoryListIds(id: RepositoryId): Promise<readonly UserListId[]> {
    this.#read(`getRepositoryListIds:${id}`);
    return Promise.resolve(
      Object.freeze([...(this.memberships.get(id) ?? [])]),
    );
  }

  star(
    repository: RepositoryCoordinates,
    operationId: string,
  ): Promise<MutationReceipt> {
    this.#record("star", operationId, repository);
    if (this.applyMutations) this.starred = true;
    this.afterMutation?.("star");
    return Promise.resolve(this.#receipt("star", operationId));
  }

  unstar(
    repository: RepositoryCoordinates,
    operationId: string,
  ): Promise<MutationReceipt> {
    this.#record("unstar", operationId, repository);
    if (this.applyMutations) this.starred = false;
    this.afterMutation?.("unstar");
    return Promise.resolve(this.#receipt("unstar", operationId));
  }

  createUserList(
    input: CreateUserListInput,
    operationId: string,
  ): Promise<UserListMutationResult> {
    this.#record("createUserList", operationId, input);
    const list = Object.freeze({
      ...this.createdList,
      name: input.name,
      description: input.description,
      isPrivate: input.isPrivate,
    });
    if (this.applyMutations) this.lists.set(list.listId, list);
    this.afterMutation?.("createUserList");
    return Promise.resolve(
      Object.freeze({
        list,
        receipt: this.#receipt("createUserList", operationId),
      }),
    );
  }

  updateUserList(
    id: UserListId,
    input: UpdateUserListInput,
    operationId: string,
  ): Promise<UserListMutationResult> {
    this.#record("updateUserList", operationId, Object.freeze({ id, input }));
    const current = this.lists.get(id);
    if (current === undefined) {
      return Promise.reject(
        new AppError("NOT_FOUND", "List is missing", { retryable: false }),
      );
    }
    const list = Object.freeze({
      ...current,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      ...(input.isPrivate === undefined ? {} : { isPrivate: input.isPrivate }),
    });
    if (this.applyMutations) this.lists.set(id, list);
    this.afterMutation?.("updateUserList");
    return Promise.resolve(
      Object.freeze({
        list,
        receipt: this.#receipt("updateUserList", operationId),
      }),
    );
  }

  deleteUserList(
    id: UserListId,
    operationId: string,
  ): Promise<MutationReceipt> {
    this.#record("deleteUserList", operationId, id);
    if (this.applyMutations) this.lists.delete(id);
    this.afterMutation?.("deleteUserList");
    return Promise.resolve(this.#receipt("deleteUserList", operationId));
  }

  setRepositoryListIds(
    id: RepositoryId,
    ids: readonly UserListId[],
    operationId: string,
  ): Promise<MutationReceipt> {
    this.#record(
      "setRepositoryListIds",
      operationId,
      Object.freeze({ id, ids: Object.freeze([...ids]) }),
    );
    if (this.applyMutations) {
      this.memberships.set(id, Object.freeze([...ids]));
    }
    this.afterMutation?.("setRepositoryListIds");
    return Promise.resolve(this.#receipt("setRepositoryListIds", operationId));
  }
}

function emptyExecutionContext(): ExecutionContext {
  return {
    createdListIdsByOperationId: new Map<string, UserListId>(),
  };
}

function common(
  operationId: string,
  dependsOn: readonly string[] = Object.freeze([]),
) {
  return {
    operationId,
    dependsOn,
  };
}

function starOperation(kind: "star" | "unstar" = "star"): ResolvedOperation {
  const originalListIds = Object.freeze([listId]);
  return Object.freeze({
    ...common(`op_${kind}`),
    kind,
    repositoryId,
    repositoryDatabaseId,
    coordinates,
    preconditions: Object.freeze([
      Object.freeze({
        kind: "star_state",
        expected: kind === "star" ? false : true,
      }),
    ]),
    before:
      kind === "star"
        ? Object.freeze({ starred: false })
        : Object.freeze({
            starred: true,
            starredAt: "2026-07-16T00:00:00.000Z",
            listIds: originalListIds,
          }),
    after:
      kind === "star"
        ? Object.freeze({ starred: true })
        : Object.freeze({ starred: false }),
    inverse:
      kind === "star"
        ? Object.freeze({ kind: "unstar" })
        : Object.freeze({ kind: "star", listIds: originalListIds }),
    risk: kind === "star" ? "normal" : "non_reversible",
  });
}

function createOperation(): ResolvedOperation {
  const baselineListIds = Object.freeze([listId]);
  return Object.freeze({
    ...common("op_create"),
    kind: "list_create",
    clientRef: "created",
    preconditions: Object.freeze([
      Object.freeze({
        kind: "list_id_baseline",
        expected: Object.freeze({ listIds: baselineListIds }),
      }),
    ]),
    before: Object.freeze({ listIds: baselineListIds }),
    after: Object.freeze({
      name: "Created",
      description: null,
      isPrivate: false,
    }),
    inverse: Object.freeze({ kind: "list_delete" }),
    risk: "normal",
  });
}

function updateOperation(): ResolvedOperation {
  const before = Object.freeze({
    name: "Original",
    description: "Before",
    isPrivate: false,
  });
  const after = Object.freeze({
    name: "Renamed",
    description: null,
    isPrivate: true,
  });
  return Object.freeze({
    ...common("op_update"),
    kind: "list_update",
    listId,
    preconditions: Object.freeze([
      Object.freeze({ kind: "list_metadata", expected: before }),
    ]),
    before,
    after,
    inverse: Object.freeze({ kind: "list_update", ...before }),
    risk: "normal",
  });
}

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

function deleteOperation(list: UserList): ResolvedOperation {
  const listState = completeList(list);
  const repositoryIds = Object.freeze([repositoryId]);
  return Object.freeze({
    ...common("op_delete"),
    kind: "list_delete",
    listId: list.listId,
    preconditions: Object.freeze([
      Object.freeze({ kind: "list_metadata", expected: listState }),
    ]),
    before: Object.freeze({
      list: listState,
      repositoryIds,
    }),
    after: Object.freeze({ exists: false }),
    inverse: Object.freeze({
      kind: "list_create",
      list: listState,
      repositoryIds,
    }),
    risk: "destructive",
  });
}

function membershipOperation(
  targetLists: Extract<
    ResolvedOperation,
    { kind: "list_membership_set" }
  >["targetLists"] = Object.freeze([
    Object.freeze({ kind: "existing" as const, listId }),
  ]),
): ResolvedOperation {
  const expectedListIds = Object.freeze([listId]);
  const dependsOn = Object.freeze(
    targetLists
      .filter(
        (
          target,
        ): target is Extract<
          (typeof targetLists)[number],
          { kind: "created" }
        > => target.kind === "created",
      )
      .map((target) => target.createOperationId)
      .sort(),
  );
  return Object.freeze({
    ...common("op_membership", dependsOn),
    kind: "list_membership_set",
    repositoryId,
    repositoryDatabaseId,
    coordinates,
    expectedListIds,
    targetLists,
    preconditions: Object.freeze([
      Object.freeze({
        kind: "list_memberships",
        expected: Object.freeze({ listIds: expectedListIds }),
      }),
    ]),
    before: Object.freeze({ listIds: expectedListIds }),
    after: Object.freeze({
      listIds: Object.freeze(
        targetLists.map((target) =>
          target.kind === "existing"
            ? target.listId
            : Object.freeze({
                createOperationId: target.createOperationId,
              }),
        ),
      ),
    }),
    inverse: Object.freeze({
      kind: "list_membership_set",
      listIds: expectedListIds,
    }),
    risk: "normal",
  });
}

function executor(github: StatefulGitHub): MutationExecutor {
  return new MutationExecutor(github, github);
}

async function prepared(
  service: MutationExecutor,
  operation: ResolvedOperation,
  context: ExecutionContext,
  signal?: AbortSignal,
): Promise<PreparedMutation> {
  const result = await service.prepare(operation, context, signal);
  expect(result.kind).toBe("dispatch");
  if (result.kind !== "dispatch") {
    throw new Error("Expected a prepared mutation");
  }
  return result.prepared;
}

type MutableRecord = Record<string, unknown>;

function mutableOperation(operation: ResolvedOperation): MutableRecord {
  return JSON.parse(JSON.stringify(operation)) as MutableRecord;
}

function mutableRecord(value: unknown): MutableRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a mutable record fixture");
  }
  return value as MutableRecord;
}

function operationValidationFixtures(): readonly ResolvedOperation[] {
  const github = new StatefulGitHub();
  return Object.freeze([
    starOperation(),
    starOperation("unstar"),
    createOperation(),
    updateOperation(),
    deleteOperation(github.lists.get(listId)!),
    membershipOperation(),
  ]);
}

function removeRequiredNestedState(candidate: MutableRecord): void {
  const before = mutableRecord(candidate.before);
  switch (candidate.kind) {
    case "star":
      delete before.starred;
      return;
    case "unstar":
      delete before.starredAt;
      return;
    case "list_create":
    case "list_membership_set":
      delete before.listIds;
      return;
    case "list_update":
      delete before.description;
      return;
    case "list_delete":
      delete before.repositoryIds;
      return;
    default:
      throw new Error("Unexpected operation fixture");
  }
}

function contradictSignedState(candidate: MutableRecord): void {
  switch (candidate.kind) {
    case "star":
      mutableRecord(candidate.inverse).kind = "star";
      return;
    case "unstar":
      mutableRecord(candidate.inverse).kind = "unstar";
      return;
    case "list_create": {
      const preconditions = candidate.preconditions as readonly unknown[];
      const expected = mutableRecord(mutableRecord(preconditions[0]).expected);
      expected.listIds = [];
      return;
    }
    case "list_update":
      mutableRecord(candidate.inverse).name = "Contradictory";
      return;
    case "list_delete":
      mutableRecord(candidate.inverse).repositoryIds = [];
      return;
    case "list_membership_set":
      candidate.expectedListIds = [];
      return;
    default:
      throw new Error("Unexpected operation fixture");
  }
}

type HostileValidationCase = Readonly<{
  kind: ResolvedOperation["kind"];
  scenario: string;
  candidate: MutableRecord;
  hookCounter: { calls: number };
}>;

function hostileValidationCases(): readonly HostileValidationCase[] {
  const cases: HostileValidationCase[] = [];
  for (const operation of operationValidationFixtures()) {
    const nestedAuthority = mutableOperation(operation);
    mutableRecord(nestedAuthority.before).route =
      "DELETE authority-secret endpoint";
    cases.push({
      kind: operation.kind,
      scenario: "nested authority",
      candidate: nestedAuthority,
      hookCounter: { calls: 0 },
    });

    const missingState = mutableOperation(operation);
    removeRequiredNestedState(missingState);
    cases.push({
      kind: operation.kind,
      scenario: "missing required state",
      candidate: missingState,
      hookCounter: { calls: 0 },
    });

    const contradiction = mutableOperation(operation);
    contradictSignedState(contradiction);
    cases.push({
      kind: operation.kind,
      scenario: "contradictory signed state",
      candidate: contradiction,
      hookCounter: { calls: 0 },
    });

    const accessorCounter = { calls: 0 };
    const nestedAccessor = mutableOperation(operation);
    Object.defineProperty(mutableRecord(nestedAccessor.before), "document", {
      enumerable: true,
      get() {
        accessorCounter.calls += 1;
        throw new Error("accessor-secret");
      },
    });
    cases.push({
      kind: operation.kind,
      scenario: "nested accessor",
      candidate: nestedAccessor,
      hookCounter: accessorCounter,
    });

    const proxyCounter = { calls: 0 };
    const nestedProxy = mutableOperation(operation);
    nestedProxy.before = new Proxy(mutableRecord(nestedProxy.before), {
      get() {
        proxyCounter.calls += 1;
        throw new Error("proxy-secret");
      },
      getOwnPropertyDescriptor() {
        proxyCounter.calls += 1;
        throw new Error("proxy-secret");
      },
      ownKeys() {
        proxyCounter.calls += 1;
        throw new Error("proxy-secret");
      },
    });
    cases.push({
      kind: operation.kind,
      scenario: "nested proxy",
      candidate: nestedProxy,
      hookCounter: proxyCounter,
    });

    const coercionCounter = { calls: 0 };
    const nestedCoercion = mutableOperation(operation);
    mutableRecord(nestedCoercion.before).endpoint = {
      [Symbol.toPrimitive]() {
        coercionCounter.calls += 1;
        throw new Error("coercion-secret");
      },
    };
    cases.push({
      kind: operation.kind,
      scenario: "nested coercion",
      candidate: nestedCoercion,
      hookCounter: coercionCounter,
    });
  }
  return Object.freeze(cases);
}

describe("MutationExecutor live preconditions", () => {
  it("rejects a malformed resolved operation before any live read", async () => {
    const github = new StatefulGitHub();
    const malformed = Object.freeze({
      ...common("op_malformed"),
      kind: "star",
      repositoryId,
      repositoryDatabaseId,
      before: Object.freeze({ starred: false }),
      after: Object.freeze({ starred: true }),
    }) as unknown as ResolvedOperation;

    await expect(
      executor(github).prepare(malformed, emptyExecutionContext()),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      retryable: false,
    });
    expect(github.reads).toEqual([]);
    expect(github.mutations).toEqual([]);
  });

  it("rejects incomplete, unsupported, and unsafe operation fields with zero hooks or live reads", async () => {
    const requiredFields = [
      "operationId",
      "kind",
      "dependsOn",
      "preconditions",
      "before",
      "after",
      "inverse",
      "risk",
      "repositoryId",
      "repositoryDatabaseId",
      "coordinates",
    ] as const;

    for (const field of requiredFields) {
      const github = new StatefulGitHub();
      const candidate = {
        ...starOperation(),
      } as unknown as Record<string, unknown>;
      delete candidate[field];

      await expect(
        executor(github).prepare(
          candidate as unknown as ResolvedOperation,
          emptyExecutionContext(),
        ),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        retryable: false,
      });
      expect(github.reads, field).toEqual([]);
      expect(github.mutations, field).toEqual([]);
    }

    for (const candidate of [
      {
        ...starOperation(),
        route: "DELETE /repos/{owner}/{repo}",
      },
      {
        ...starOperation(),
        document: "mutation UnexpectedAuthority { deleteRepository }",
      },
    ]) {
      const github = new StatefulGitHub();
      await expect(
        executor(github).prepare(
          candidate as unknown as ResolvedOperation,
          emptyExecutionContext(),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(github.reads).toEqual([]);
      expect(github.mutations).toEqual([]);
    }

    const unsafeOperationIds = [
      "github_pat_executor-secret",
      "not-an-operation-id",
      "op_",
      "op_control\u0085value",
      `op_${"x".repeat(126)}`,
    ];
    for (const operationId of unsafeOperationIds) {
      const github = new StatefulGitHub();
      let caught: unknown;
      try {
        await executor(github).prepare(
          {
            ...starOperation(),
            operationId,
          },
          emptyExecutionContext(),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(JSON.stringify(caught)).not.toContain(operationId);
      expect(github.reads).toEqual([]);
      expect(github.mutations).toEqual([]);
    }

    let getterCalls = 0;
    const accessor = { ...starOperation() } as Record<string, unknown>;
    Object.defineProperty(accessor, "route", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("getter-secret");
      },
    });
    const accessorGitHub = new StatefulGitHub();
    await expect(
      executor(accessorGitHub).prepare(
        accessor as unknown as ResolvedOperation,
        emptyExecutionContext(),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(getterCalls).toBe(0);
    expect(accessorGitHub.reads).toEqual([]);

    let proxyTrapCalls = 0;
    const proxied = new Proxy(starOperation(), {
      get() {
        proxyTrapCalls += 1;
        throw new Error("proxy-secret");
      },
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error("proxy-secret");
      },
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("proxy-secret");
      },
    });
    const proxyGitHub = new StatefulGitHub();
    await expect(
      executor(proxyGitHub).prepare(proxied, emptyExecutionContext()),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(proxyTrapCalls).toBe(0);
    expect(proxyGitHub.reads).toEqual([]);
  });

  it.each(hostileValidationCases())(
    "rejects $kind $scenario before hooks, context, or GitHub",
    async ({ candidate, hookCounter }) => {
      const github = new StatefulGitHub();
      const context = emptyExecutionContext();
      context.createdListIdsByOperationId.set(
        "op_seed",
        asUserListId("UL_seed"),
      );
      let caught: unknown;
      try {
        await executor(github).prepare(
          candidate as unknown as ResolvedOperation,
          context,
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        code: "VALIDATION_ERROR",
        retryable: false,
      });
      expect(JSON.stringify(caught)).not.toMatch(
        /authority-secret|accessor-secret|proxy-secret|coercion-secret/u,
      );
      expect(hookCounter.calls).toBe(0);
      expect(github.reads).toEqual([]);
      expect(github.mutations).toEqual([]);
      expect(context.createdListIdsByOperationId).toEqual(
        new Map([["op_seed", asUserListId("UL_seed")]]),
      );
    },
  );

  it.each([
    ["node ID", asRepositoryId("R_other"), repositoryDatabaseId],
    ["database ID", repositoryId, asRepositoryDatabaseId("999")],
  ])(
    "rejects a changed repository %s before star and unstar",
    async (_label, actualRepositoryId, actualDatabaseId) => {
      for (const kind of ["star", "unstar"] as const) {
        const github = new StatefulGitHub();
        github.starred = kind === "unstar";
        github.identity = Object.freeze({
          repositoryId: actualRepositoryId,
          repositoryDatabaseId: actualDatabaseId,
          coordinates,
        });

        await expect(
          executor(github).prepare(
            starOperation(kind),
            emptyExecutionContext(),
          ),
        ).rejects.toMatchObject({
          code: "PRECONDITION_FAILED",
          retryable: false,
        });
        expect(github.reads).toEqual(["getRepositoryIdentity"]);
        expect(github.mutations).toEqual([]);
      }
    },
  );

  it.each(["list_update", "list_delete"] as const)(
    "rejects changed complete List metadata before %s",
    async (kind) => {
      const github = new StatefulGitHub();
      const original = github.lists.get(listId)!;
      github.lists.set(
        listId,
        Object.freeze(
          kind === "list_update"
            ? { ...original, name: "Changed elsewhere" }
            : {
                ...original,
                updatedAt: "2026-07-16T00:03:00.000Z",
              },
        ),
      );
      const operation =
        kind === "list_update" ? updateOperation() : deleteOperation(original);

      await expect(
        executor(github).prepare(operation, emptyExecutionContext()),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        retryable: false,
      });
      expect(github.mutations).toEqual([]);
    },
  );

  it("requires the requested stable List ID for update preconditions", async () => {
    const github = new StatefulGitHub();
    const wrongId = asUserListId("UL_other");
    const sameMetadata = github.lists.get(listId)!;
    github.getUserList = () => {
      github.reads.push(`getUserList:${listId}`);
      return Promise.resolve(
        Object.freeze({
          ...sameMetadata,
          listId: wrongId,
        }),
      );
    };

    await expect(
      executor(github).prepare(updateOperation(), emptyExecutionContext()),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      retryable: false,
    });
    expect(github.reads).toEqual([`getUserList:${listId}`]);
    expect(github.mutations).toEqual([]);
  });

  it("accepts bounded GitHub List descriptions without trimming signed state", async () => {
    const description = " Before ";
    const before = Object.freeze({
      name: "Original",
      description,
      isPrivate: false,
    });
    const after = Object.freeze({
      name: "Original",
      description,
      isPrivate: true,
    });
    const operation = Object.freeze({
      ...common("op_update_description"),
      kind: "list_update" as const,
      listId,
      preconditions: Object.freeze([
        Object.freeze({ kind: "list_metadata", expected: before }),
      ]),
      before,
      after,
      inverse: Object.freeze({ kind: "list_update", ...before }),
      risk: "normal" as const,
    });
    const github = new StatefulGitHub();
    github.lists.set(
      listId,
      Object.freeze({
        ...github.lists.get(listId)!,
        description,
      }),
    );
    const service = executor(github);
    const context = emptyExecutionContext();

    await expect(
      service.dispatchPrepared(
        await prepared(service, operation, context),
        context,
      ),
    ).resolves.toMatchObject({
      kind: "succeeded",
      after: { name: "Original", description, isPrivate: true },
    });
  });

  it("rejects a changed complete membership set before mutation", async () => {
    const github = new StatefulGitHub();
    github.memberships.set(
      repositoryId,
      Object.freeze([listId, asUserListId("UL_extra")]),
    );

    await expect(
      executor(github).prepare(membershipOperation(), emptyExecutionContext()),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      retryable: false,
    });
    expect(github.reads).toEqual([
      "getRepositoryIdentity",
      `getRepositoryListIds:${repositoryId}`,
    ]);
    expect(github.mutations).toEqual([]);
  });

  it("checks cancellation before and after live reads", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const githubBefore = new StatefulGitHub();
    await expect(
      executor(githubBefore).prepare(
        starOperation(),
        emptyExecutionContext(),
        alreadyAborted.signal,
      ),
    ).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { reason: "cancelled" },
    });
    expect(githubBefore.reads).toEqual([]);

    const afterRead = new AbortController();
    const githubAfter = new StatefulGitHub();
    githubAfter.onRead = (name) => {
      if (name === "getRepositoryIdentity") afterRead.abort();
    };
    await expect(
      executor(githubAfter).prepare(
        starOperation(),
        emptyExecutionContext(),
        afterRead.signal,
      ),
    ).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { reason: "cancelled" },
    });
    expect(githubAfter.reads).toEqual(["getRepositoryIdentity"]);
    expect(githubAfter.mutations).toEqual([]);
  });
});

describe("MutationExecutor desired-state skips", () => {
  it("skips an already-starred repository with zero mutation calls", async () => {
    const github = new StatefulGitHub();
    github.starred = true;

    await expect(
      executor(github).prepare(starOperation(), emptyExecutionContext()),
    ).resolves.toMatchObject({
      kind: "skipped",
      outcome: {
        kind: "skipped",
        before: { starred: true },
        after: { starred: true },
        receipt: null,
      },
    });
    expect(github.mutations).toEqual([]);
  });

  it("skips an already-updated List and an already-deleted List", async () => {
    const updatedGitHub = new StatefulGitHub();
    const current = updatedGitHub.lists.get(listId)!;
    updatedGitHub.lists.set(
      listId,
      Object.freeze({
        ...current,
        name: "Renamed",
        description: null,
        isPrivate: true,
      }),
    );
    await expect(
      executor(updatedGitHub).prepare(
        updateOperation(),
        emptyExecutionContext(),
      ),
    ).resolves.toMatchObject({
      kind: "skipped",
      outcome: { kind: "skipped", receipt: null },
    });
    expect(updatedGitHub.mutations).toEqual([]);

    const deletedGitHub = new StatefulGitHub();
    const deleted = deletedGitHub.lists.get(listId)!;
    deletedGitHub.lists.delete(listId);
    await expect(
      executor(deletedGitHub).prepare(
        deleteOperation(deleted),
        emptyExecutionContext(),
      ),
    ).resolves.toMatchObject({
      kind: "skipped",
      outcome: {
        kind: "skipped",
        after: { exists: false },
        receipt: null,
      },
    });
    expect(deletedGitHub.mutations).toEqual([]);
  });

  it("skips an already-complete desired membership set", async () => {
    const targetId = asUserListId("UL_target");
    const github = new StatefulGitHub();
    github.memberships.set(repositoryId, Object.freeze([targetId]));
    const operation = membershipOperation(
      Object.freeze([Object.freeze({ kind: "existing", listId: targetId })]),
    );

    await expect(
      executor(github).prepare(operation, emptyExecutionContext()),
    ).resolves.toMatchObject({
      kind: "skipped",
      outcome: {
        kind: "skipped",
        after: { listIds: [targetId] },
        receipt: null,
      },
    });
    expect(github.mutations).toEqual([]);
  });

  it("uses a prior create context to skip an already-created List", async () => {
    const github = new StatefulGitHub();
    github.lists.set(createdListId, github.createdList);
    const context = emptyExecutionContext();
    context.createdListIdsByOperationId.set("op_create", createdListId);

    await expect(
      executor(github).prepare(createOperation(), context),
    ).resolves.toMatchObject({
      kind: "skipped",
      outcome: {
        kind: "skipped",
        after: { listId: createdListId, name: "Created" },
        receipt: null,
      },
    });
    expect(github.mutations).toEqual([]);
  });
});

describe("MutationExecutor prepared dispatch", () => {
  it("prepares without dispatch, freezes the value, and records star synchronously", async () => {
    const github = new StatefulGitHub();
    const service = executor(github);
    const context = emptyExecutionContext();
    const value = await prepared(service, starOperation(), context);

    expect(github.mutations).toEqual([]);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.mutation)).toBe(true);
    const promise = service.dispatchPrepared(value, context);
    expect(github.mutations.map((call) => call.kind)).toEqual(["star"]);

    await expect(promise).resolves.toEqual({
      kind: "succeeded",
      before: { starred: false },
      after: { starred: true },
      receipt: {
        requestId: "REQ-1",
        clientMutationId: null,
      },
    });
  });

  it("checks cancellation immediately before the unique dispatch", async () => {
    const github = new StatefulGitHub();
    const service = executor(github);
    const context = emptyExecutionContext();
    const value = await prepared(service, starOperation(), context);
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.dispatchPrepared(value, context, controller.signal),
    ).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
      details: { reason: "cancelled" },
    });
    expect(github.mutations).toEqual([]);
  });

  it("rejects forged, context-mismatched, and reused prepared values", async () => {
    const github = new StatefulGitHub();
    const service = executor(github);
    const context = emptyExecutionContext();
    const value = await prepared(service, starOperation(), context);
    const forged = Object.freeze({
      operation: starOperation(),
      before: Object.freeze({ starred: false }),
      mutation: Object.freeze({ kind: "star", coordinates }),
    }) as PreparedMutation;

    await expect(
      service.dispatchPrepared(forged, context),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      service.dispatchPrepared(value, emptyExecutionContext()),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await service.dispatchPrepared(value, context);
    await expect(
      service.dispatchPrepared(value, context),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(github.mutations.map((call) => call.kind)).toEqual(["star"]);
  });

  it("throws reconciliation required when successful dispatch has no exact after state", async () => {
    const github = new StatefulGitHub();
    github.applyMutations = false;
    const service = executor(github);
    const context = emptyExecutionContext();
    const value = await prepared(service, starOperation(), context);

    await expect(
      service.dispatchPrepared(value, context),
    ).rejects.toMatchObject({
      code: "RECONCILIATION_REQUIRED",
      retryable: false,
      details: { operationId: "op_star", mutationName: "star" },
    });
    expect(github.mutations.map((call) => call.kind)).toEqual(["star"]);
  });

  it("treats a changed repository identity during readback as reconciliation required", async () => {
    const github = new StatefulGitHub();
    github.afterMutation = () => {
      github.identity = Object.freeze({
        repositoryId: asRepositoryId("R_replaced"),
        repositoryDatabaseId,
        coordinates,
      });
    };
    const service = executor(github);
    const context = emptyExecutionContext();

    await expect(
      service.dispatchPrepared(
        await prepared(service, starOperation(), context),
        context,
      ),
    ).rejects.toMatchObject({
      code: "RECONCILIATION_REQUIRED",
      retryable: false,
    });
    expect(github.mutations).toHaveLength(1);
  });

  it("requires a created List ID outside the signed baseline before recording context", async () => {
    const github = new StatefulGitHub();
    github.createdList = Object.freeze({
      ...github.createdList,
      listId,
    });
    const service = executor(github);
    const context = emptyExecutionContext();
    context.createdListIdsByOperationId.set("op_seed", asUserListId("UL_seed"));
    const beforeContext = new Map(context.createdListIdsByOperationId);

    await expect(
      service.dispatchPrepared(
        await prepared(service, createOperation(), context),
        context,
      ),
    ).rejects.toMatchObject({
      code: "RECONCILIATION_REQUIRED",
      retryable: false,
      details: {
        operationId: "op_create",
        mutationName: "createUserList",
      },
    });

    expect(github.mutations.map((call) => call.kind)).toEqual([
      "createUserList",
    ]);
    expect(github.reads).toEqual([`getUserList:${listId}`]);
    expect(context.createdListIdsByOperationId).toEqual(beforeContext);
  });

  it("copies and freezes a successful mutation receipt", async () => {
    const github = new StatefulGitHub();
    const receipt: {
      requestId: string | null;
      clientMutationId: string | null;
    } = {
      requestId: "REQ-mutable",
      clientMutationId: null,
    };
    github.star = (repository: RepositoryCoordinates, operationId: string) => {
      github.mutations.push(
        Object.freeze({
          kind: "star",
          operationId,
          value: repository,
        }),
      );
      github.starred = true;
      return Promise.resolve(receipt);
    };
    const service = executor(github);
    const context = emptyExecutionContext();

    const result = await service.dispatchPrepared(
      await prepared(service, starOperation(), context),
      context,
    );

    expect(Object.isFrozen(result.receipt)).toBe(true);
    receipt.requestId = "REQ-changed";
    expect(result.receipt?.requestId).toBe("REQ-mutable");
  });
});

describe("MutationExecutor allowlisted operations", () => {
  it("dispatches all six named mutations exactly once with exact readback", async () => {
    const observedKinds: MutationCall["kind"][] = [];

    {
      const github = new StatefulGitHub();
      const service = executor(github);
      const context = emptyExecutionContext();
      await service.dispatchPrepared(
        await prepared(service, starOperation(), context),
        context,
      );
      observedKinds.push(...github.mutations.map((call) => call.kind));
    }
    {
      const github = new StatefulGitHub();
      github.starred = true;
      const service = executor(github);
      const context = emptyExecutionContext();
      await service.dispatchPrepared(
        await prepared(service, starOperation("unstar"), context),
        context,
      );
      observedKinds.push(...github.mutations.map((call) => call.kind));
    }
    {
      const github = new StatefulGitHub();
      const service = executor(github);
      const context = emptyExecutionContext();
      await service.dispatchPrepared(
        await prepared(service, createOperation(), context),
        context,
      );
      observedKinds.push(...github.mutations.map((call) => call.kind));
      expect(context.createdListIdsByOperationId.get("op_create")).toBe(
        createdListId,
      );
    }
    {
      const github = new StatefulGitHub();
      const service = executor(github);
      const context = emptyExecutionContext();
      await service.dispatchPrepared(
        await prepared(service, updateOperation(), context),
        context,
      );
      observedKinds.push(...github.mutations.map((call) => call.kind));
    }
    {
      const github = new StatefulGitHub();
      const current = github.lists.get(listId)!;
      const service = executor(github);
      const context = emptyExecutionContext();
      await service.dispatchPrepared(
        await prepared(service, deleteOperation(current), context),
        context,
      );
      observedKinds.push(...github.mutations.map((call) => call.kind));
    }
    {
      const github = new StatefulGitHub();
      const targetId = asUserListId("UL_target");
      const operation = membershipOperation(
        Object.freeze([Object.freeze({ kind: "existing", listId: targetId })]),
      );
      const service = executor(github);
      const context = emptyExecutionContext();
      await service.dispatchPrepared(
        await prepared(service, operation, context),
        context,
      );
      observedKinds.push(...github.mutations.map((call) => call.kind));
    }

    expect(observedKinds).toEqual([
      "star",
      "unstar",
      "createUserList",
      "updateUserList",
      "deleteUserList",
      "setRepositoryListIds",
    ]);
  });

  it("stores the created List ID and returns it in the succeeded after state", async () => {
    const github = new StatefulGitHub();
    const service = executor(github);
    const context = emptyExecutionContext();
    const result = await service.dispatchPrepared(
      await prepared(service, createOperation(), context),
      context,
    );

    expect(context.createdListIdsByOperationId).toEqual(
      new Map([["op_create", createdListId]]),
    );
    expect(result).toMatchObject({
      kind: "succeeded",
      after: {
        listId: createdListId,
        name: "Created",
        description: null,
        isPrivate: false,
      },
      receipt: {
        requestId: "REQ-1",
        clientMutationId: "op_create",
      },
    });
  });

  it("resolves created targets and UTF-8 sorts unique membership IDs without changing context", async () => {
    const utf16First = asUserListId("UL_𐀀");
    const utf8First = asUserListId("UL_\uE000");
    expect([utf16First, utf8First].sort()).toEqual([utf16First, utf8First]);
    expect(
      [utf16First, utf8First].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
    ).toEqual([utf8First, utf16First]);

    const github = new StatefulGitHub();
    github.memberships.set(repositoryId, Object.freeze([listId]));
    const context = emptyExecutionContext();
    context.createdListIdsByOperationId.set("op_created_a", utf16First);
    context.createdListIdsByOperationId.set("op_created_b", utf8First);
    const service = executor(github);
    const operation = membershipOperation(
      Object.freeze([
        Object.freeze({ kind: "existing", listId: utf8First }),
        Object.freeze({
          kind: "created",
          createOperationId: "op_created_a",
        }),
        Object.freeze({
          kind: "created",
          createOperationId: "op_created_b",
        }),
      ]),
    );

    await service.dispatchPrepared(
      await prepared(service, operation, context),
      context,
    );

    expect(github.mutations).toHaveLength(1);
    expect(github.mutations[0]).toMatchObject({
      kind: "setRepositoryListIds",
      value: {
        id: repositoryId,
        ids: [utf8First, utf16First],
      },
    });
    expect(context.createdListIdsByOperationId).toEqual(
      new Map([
        ["op_created_a", utf16First],
        ["op_created_b", utf8First],
      ]),
    );
  });

  it("fails before mutation when a created membership target is unresolved", async () => {
    const github = new StatefulGitHub();
    const operation = membershipOperation(
      Object.freeze([
        Object.freeze({
          kind: "created",
          createOperationId: "op_missing_create",
        }),
      ]),
    );

    await expect(
      executor(github).prepare(operation, emptyExecutionContext()),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      retryable: false,
    });
    expect(github.mutations).toEqual([]);
  });

  it("exposes no generic dispatch method or route/document mutation", () => {
    const github = new StatefulGitHub();
    const service = executor(github) as unknown as Record<string, unknown>;

    expect(service.request).toBeUndefined();
    expect(service.dispatch).toBeUndefined();
    expect(service.execute).toBeUndefined();
    expect(Object.keys(service)).toEqual([]);
  });
});
