import { expect, test, vi } from "vitest";
import { AppError } from "../../../src/domain/errors.js";
import {
  asPlanId,
  asRepositoryDatabaseId,
  asRepositoryId,
  asRunId,
  asSnapshotId,
  asUserListId,
} from "../../../src/domain/ids.js";
import {
  canonicalJson,
  sha256Hex,
} from "../../../src/domain/canonical-json.js";
import {
  hashPlanExecutable,
  parseChangePlan,
  parsePlanExecutable,
  parsePlanRequest,
  reverseDependencyOperationIds,
  topologicalOperationIds,
  transitionPlanState,
  type ChangePlan,
  type OperationDependency,
  type PlanAction,
  type PlanExecutableContent,
  type PlanState,
  type ResolvedOperation,
} from "../../../src/domain/plan.js";
import {
  parseChangeRun,
  parseRunOperation,
  parseRunOperationAttempt,
  parseRunOperationReconciliation,
  recoverRunState,
  transitionRunState,
  type RunState,
} from "../../../src/domain/run.js";

const binding = Object.freeze({
  host: "github.com",
  login: "octocat",
  accountId: "U_1",
});

function createOperation(
  operationId = "create",
): Extract<ResolvedOperation, { readonly kind: "list_create" }> {
  return {
    operationId,
    kind: "list_create",
    dependsOn: [],
    preconditions: [],
    before: { listIds: [] },
    after: {
      name: "AI",
      description: null,
      isPrivate: false,
    },
    inverse: { kind: "list_delete" },
    risk: "normal",
    clientRef: "ref_ai",
  };
}

function starOperation(
  operationId = "star",
  kind: "star" | "unstar" = "star",
): Extract<ResolvedOperation, { readonly kind: "star" | "unstar" }> {
  return {
    operationId,
    kind,
    dependsOn: [],
    preconditions: [
      { kind: "star_state", expected: kind === "star" ? false : true },
    ],
    before: { starred: kind === "unstar" },
    after: { starred: kind === "star" },
    inverse: { kind: kind === "star" ? "unstar" : "star" },
    risk: kind === "unstar" ? "destructive" : "normal",
    repositoryId: asRepositoryId(`R_${operationId}`),
    repositoryDatabaseId: asRepositoryDatabaseId("101"),
    coordinates: { owner: "octocat", name: "hello-world" },
  };
}

function membershipOperation(
  operationId = "assign",
  dependsOn: readonly string[] = ["create"],
): Extract<ResolvedOperation, { readonly kind: "list_membership_set" }> {
  return {
    operationId,
    kind: "list_membership_set",
    dependsOn,
    preconditions: [{ kind: "list_ids", expected: [] }],
    before: { listIds: [] },
    after: { targets: [{ kind: "created", createOperationId: "create" }] },
    inverse: { listIds: [] },
    risk: "normal",
    repositoryId: asRepositoryId("R_assign"),
    repositoryDatabaseId: asRepositoryDatabaseId("102"),
    coordinates: { owner: "octocat", name: "agent-tools" },
    expectedListIds: [],
    targetLists: [{ kind: "created", createOperationId: "create" }],
  };
}

function executable(
  overrides: Partial<PlanExecutableContent> = {},
): PlanExecutableContent {
  return {
    schemaVersion: 1,
    policyVersion: "1",
    binding,
    snapshotId: asSnapshotId("snap_1"),
    protectedRepositoryIds: [],
    protectedListIds: [],
    operations: [],
    dependencies: [],
    ...overrides,
  };
}

function expectAppError(action: () => unknown, code: AppError["code"]): void {
  try {
    action();
    throw new Error("expected action to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }
}

function assertRequestAndResolvedReferencesStaySeparate(): void {
  const request: PlanAction = {
    kind: "list_membership_add",
    repositories: {
      kind: "ids",
      repositoryIds: [asRepositoryId("R_1")],
    },
    lists: [{ kind: "created", clientRef: "ref_ai" }],
  };
  void request;

  const invalidRequest: PlanAction = {
    kind: "list_membership_add",
    repositories: {
      kind: "ids",
      repositoryIds: [asRepositoryId("R_1")],
    },
    lists: [
      // @ts-expect-error Request-time targets cannot contain resolved operation IDs.
      { kind: "created", createOperationId: "create" },
    ],
  };
  void invalidRequest;

  const resolved = membershipOperation();
  void resolved;
}

void assertRequestAndResolvedReferencesStaySeparate;

test("canonicalizes JSON and hashes UTF-8 with the known SHA-256 vector", () => {
  expect(canonicalJson({ z: 1, a: [true, null], n: -0 })).toBe(
    '{"a":[true,null],"n":0,"z":1}',
  );
  expect(sha256Hex("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(sha256Hex("你好")).toMatch(/^[a-f0-9]{64}$/u);

  const shared = { value: 1 };
  expect(canonicalJson({ left: shared, right: shared })).toBe(
    '{"left":{"value":1},"right":{"value":1}}',
  );
});

test("canonical JSON rejects hostile, exotic, cyclic, and oversized values", () => {
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "secret", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "ghp_secret_should_not_leak";
    },
  });

  let iteratorCalls = 0;
  const iterable = [1];
  Object.defineProperty(iterable, Symbol.iterator, {
    get() {
      iteratorCalls += 1;
      return Array.prototype[Symbol.iterator];
    },
  });

  let proxyCalls = 0;
  const proxy = new Proxy(
    { value: 1 },
    {
      ownKeys() {
        proxyCalls += 1;
        return ["value"];
      },
    },
  );

  const sparse = new Array(2);
  sparse[1] = true;
  const extraArray = [1];
  Object.defineProperty(extraArray, "extra", {
    enumerable: true,
    value: 2,
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let tooDeep: unknown = null;
  for (let index = 0; index < 70; index += 1) {
    tooDeep = { child: tooDeep };
  }

  for (const invalid of [
    accessor,
    iterable,
    proxy,
    sparse,
    extraArray,
    cycle,
    tooDeep,
    Object.assign(Object.create({ inherited: true }) as object, { value: 1 }),
    new Date("2026-07-16T00:00:00.000Z"),
    { toJSON: () => ({ hidden: true }) },
    { value: undefined },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: 1n },
    { value: Symbol("secret") },
    { value: () => true },
    { value: "x".repeat(1_048_577) },
  ]) {
    expectAppError(() => canonicalJson(invalid), "VALIDATION_ERROR");
  }

  expect(getterCalls).toBe(0);
  expect(iteratorCalls).toBe(0);
  expect(proxyCalls).toBe(0);
  try {
    canonicalJson(accessor);
  } catch (error) {
    expect((error as Error).message).not.toContain(
      "ghp_secret_should_not_leak",
    );
  }
});

test("rejects cumulative canonical output before attempting a large join", () => {
  const repeatedLargeValue = "x".repeat(1_048_500);
  const input = new Array<string>(65).fill(repeatedLargeValue);
  const originalJoin = Array.prototype.join;
  let largeJoinCalls = 0;
  const joinSpy = vi
    .spyOn(Array.prototype, "join")
    .mockImplementation(function (this: unknown[], separator?: string) {
      if (this.length >= input.length) {
        largeJoinCalls += 1;
        throw new Error("large join must not be attempted");
      }
      return originalJoin.call(this, separator);
    });

  let thrown: unknown;
  try {
    canonicalJson(input);
  } catch (error) {
    thrown = error;
  } finally {
    joinSpy.mockRestore();
  }

  expect(thrown).toBeInstanceOf(AppError);
  expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
  expect(largeJoinCalls).toBe(0);
});

test("parses and freezes request actions while preserving request-time references", () => {
  const request = parsePlanRequest({
    snapshotId: "snap_1",
    actions: [
      {
        kind: "list_update",
        listIds: ["UL_2", "UL_1"],
        description: "updated",
      },
      {
        kind: "list_membership_add",
        repositories: { kind: "ids", repositoryIds: ["R_2", "R_1"] },
        lists: [
          { kind: "created", clientRef: "ref_ai" },
          { kind: "existing", listId: "UL_1" },
        ],
      },
      {
        kind: "star",
        repositories: {
          kind: "filter",
          filter: {
            field: "stargazer_count",
            op: "gte",
            value: 10_000,
          },
        },
      },
      {
        kind: "list_create",
        clientRef: "ref_new",
        name: "New List",
        description: null,
        isPrivate: true,
      },
    ],
    protectedRepositoryIds: ["R_2", "R_1"],
    protectedListIds: ["UL_2", "UL_1"],
    ttlMinutes: 60,
    maxOperations: 100,
    callerNote: "cleanup",
  });

  expect(request.snapshotId).toBe("snap_1");
  expect(request.protectedRepositoryIds).toEqual(["R_2", "R_1"]);
  expect(request.actions[0]).toMatchObject({
    kind: "list_update",
    listIds: ["UL_2", "UL_1"],
    description: "updated",
  });
  expect(request.actions[1]).toMatchObject({
    lists: [
      { kind: "created", clientRef: "ref_ai" },
      { kind: "existing", listId: "UL_1" },
    ],
  });
  expect(request.actions[3]).toEqual({
    kind: "list_create",
    clientRef: "ref_new",
    name: "New List",
    description: null,
    isPrivate: true,
  });
  expect(Object.isFrozen(request)).toBe(true);
  expect(Object.isFrozen(request.actions)).toBe(true);
  expect(Object.isFrozen(request.actions[1])).toBe(true);
  expect(Object.isFrozen((request.actions[1] as { lists: object }).lists)).toBe(
    true,
  );
});

test("request parser is strict about list updates and reference phases", () => {
  const base = {
    snapshotId: "snap_1",
    protectedRepositoryIds: [],
    protectedListIds: [],
  };
  const invalidActions = [
    { kind: "list_update", listIds: ["UL_1"] },
    {
      kind: "list_update",
      listId: "UL_1",
      name: "new name",
    },
    {
      kind: "list_update",
      listIds: [],
      name: "new name",
    },
    {
      kind: "list_membership_set",
      repositories: { kind: "ids", repositoryIds: ["R_1"] },
      lists: [{ kind: "created", createOperationId: "create" }],
    },
    {
      kind: "list_membership_remove",
      repositories: { kind: "ids", repositoryIds: ["R_1"] },
      lists: [{ kind: "created", clientRef: "ref_ai" }],
    },
  ];
  for (const action of invalidActions) {
    expectAppError(
      () => parsePlanRequest({ ...base, actions: [action] }),
      "VALIDATION_ERROR",
    );
  }

  expectAppError(
    () => parsePlanRequest({ ...base, actions: [], extra: true }),
    "VALIDATION_ERROR",
  );
  expectAppError(
    () =>
      parsePlanRequest({
        ...base,
        actions: [{ kind: "list_delete", listIds: [" UL_1"] }],
      }),
    "VALIDATION_ERROR",
  );
  expectAppError(
    () =>
      parsePlanRequest({
        ...base,
        actions: [
          {
            kind: "list_create",
            clientRef: "ref",
            name: " ",
            description: null,
            isPrivate: false,
          },
        ],
      }),
    "VALIDATION_ERROR",
  );
});

test("parses every closed resolved operation variant into a frozen executable", () => {
  const operations: readonly ResolvedOperation[] = [
    starOperation("star", "star"),
    starOperation("unstar", "unstar"),
    createOperation("create"),
    {
      operationId: "update",
      kind: "list_update",
      dependsOn: [],
      preconditions: [],
      before: { name: "Old" },
      after: { name: "New" },
      inverse: { name: "Old" },
      risk: "normal",
      listId: asUserListId("UL_1"),
    },
    {
      operationId: "delete",
      kind: "list_delete",
      dependsOn: [],
      preconditions: [],
      before: {
        list: {
          listId: "UL_2",
          name: "Delete",
          slug: "delete",
          description: null,
          isPrivate: false,
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
          lastAddedAt: null,
        },
        repositoryIds: ["R_1"],
      },
      after: null,
      inverse: { kind: "list_create" },
      risk: "destructive",
      listId: asUserListId("UL_2"),
    },
    membershipOperation(),
  ];
  const parsed = parsePlanExecutable(
    executable({
      protectedRepositoryIds: [asRepositoryId("R_protected")],
      protectedListIds: [asUserListId("UL_protected")],
      operations,
      dependencies: [{ operationId: "assign", dependsOnOperationId: "create" }],
    }),
  );

  expect(parsed.operations.map(({ kind }) => kind)).toEqual([
    "star",
    "unstar",
    "list_create",
    "list_update",
    "list_delete",
    "list_membership_set",
  ]);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.binding)).toBe(true);
  expect(Object.isFrozen(parsed.operations)).toBe(true);
  expect(Object.isFrozen(parsed.operations[0]?.preconditions)).toBe(true);
  expect(Object.isFrozen(parsed.operations[0]?.before)).toBe(true);
});

test("executable parser rejects extra fields, wrong versions, and request-only operations", () => {
  for (const invalid of [
    { ...executable(), schemaVersion: 2 },
    { ...executable(), policyVersion: "2" },
    {
      ...executable(),
      binding: { ...binding, host: "evil.example" },
    },
    { ...executable(), metadata: "ignored" },
    {
      ...executable(),
      operations: [
        {
          ...starOperation(),
          kind: "list_membership_add",
        },
      ],
    },
    {
      ...executable(),
      operations: [{ ...starOperation(), arbitrary: true }],
    },
  ]) {
    expectAppError(() => parsePlanExecutable(invalid), "VALIDATION_ERROR");
  }
});

test("executable parser requires canonical sorted unique arrays", () => {
  const create = createOperation();
  const assign = membershipOperation();
  const dependencies = [
    { operationId: "assign", dependsOnOperationId: "create" },
  ] as const;
  const valid = executable({
    operations: [create, assign],
    dependencies,
  });

  const invalidInputs = [
    { ...valid, protectedRepositoryIds: ["R_2", "R_1"] },
    { ...valid, protectedRepositoryIds: ["R_1", "R_1"] },
    { ...valid, protectedListIds: ["UL_2", "UL_1"] },
    {
      ...valid,
      operations: [create, { ...assign, dependsOn: ["z", "create"] }],
    },
    {
      ...valid,
      operations: [
        create,
        {
          ...assign,
          expectedListIds: ["UL_2", "UL_1"],
        },
      ],
    },
    {
      ...valid,
      operations: [
        create,
        {
          ...assign,
          targetLists: [
            { kind: "existing", listId: "UL_2" },
            { kind: "existing", listId: "UL_1" },
          ],
        },
      ],
      dependencies: [],
    },
    {
      ...valid,
      operations: [
        create,
        {
          ...assign,
          targetLists: [
            { kind: "created", createOperationId: "create" },
            { kind: "created", createOperationId: "create" },
          ],
        },
      ],
    },
  ];
  for (const invalid of invalidInputs) {
    expectAppError(() => parsePlanExecutable(invalid), "VALIDATION_ERROR");
  }
});

test("validates graph agreement and created-list dependencies", () => {
  const create = createOperation();
  const assign = membershipOperation();
  const edge: OperationDependency = {
    operationId: "assign",
    dependsOnOperationId: "create",
  };
  expect(
    parsePlanExecutable(
      executable({ operations: [assign, create], dependencies: [edge] }),
    ).operations,
  ).toHaveLength(2);

  const malformed = [
    executable({ operations: [create, assign], dependencies: [] }),
    executable({
      operations: [create, { ...assign, dependsOn: [] }],
      dependencies: [edge],
    }),
    executable({
      operations: [create, assign],
      dependencies: [edge, edge],
    }),
    executable({
      operations: [create, assign],
      dependencies: [
        { operationId: "assign", dependsOnOperationId: "missing" },
      ],
    }),
    executable({
      operations: [create, assign],
      dependencies: [{ operationId: "assign", dependsOnOperationId: "assign" }],
    }),
    executable({
      operations: [
        create,
        {
          ...assign,
          dependsOn: ["missing"],
          targetLists: [{ kind: "created", createOperationId: "missing" }],
        },
      ],
      dependencies: [
        { operationId: "assign", dependsOnOperationId: "missing" },
      ],
    }),
  ];
  for (const input of malformed) {
    expectAppError(() => parsePlanExecutable(input), "VALIDATION_ERROR");
  }
});

test("uses global original-index Kahn tie-breaking and exact reverse order", () => {
  const operations: readonly ResolvedOperation[] = [
    { ...createOperation("zero"), dependsOn: ["one"], clientRef: "ref_zero" },
    { ...createOperation("one"), clientRef: "ref_one" },
    { ...createOperation("two"), dependsOn: ["three"], clientRef: "ref_two" },
    { ...createOperation("three"), clientRef: "ref_three" },
  ];
  const dependencies: readonly OperationDependency[] = [
    { operationId: "zero", dependsOnOperationId: "one" },
    { operationId: "two", dependsOnOperationId: "three" },
  ];

  expect(topologicalOperationIds(operations, dependencies)).toEqual([
    "one",
    "zero",
    "three",
    "two",
  ]);
  expect(reverseDependencyOperationIds(operations, dependencies)).toEqual([
    "two",
    "three",
    "zero",
    "one",
  ]);
  expect(
    Object.isFrozen(topologicalOperationIds(operations, dependencies)),
  ).toBe(true);
});

test("topological validation rejects every malformed graph class", () => {
  const one = createOperation("one");
  const two = { ...createOperation("two"), clientRef: "ref_two" };
  const cases: readonly [
    readonly ResolvedOperation[],
    readonly OperationDependency[],
  ][] = [
    [[one, { ...one }], []],
    [[{ ...one, dependsOn: ["x", "x"] }], []],
    [[one], [{ operationId: "missing", dependsOnOperationId: "one" }]],
    [[one], [{ operationId: "one", dependsOnOperationId: "missing" }]],
    [[one], [{ operationId: "one", dependsOnOperationId: "one" }]],
    [
      [
        { ...one, dependsOn: ["two"] },
        { ...two, dependsOn: ["one"] },
      ],
      [
        { operationId: "one", dependsOnOperationId: "two" },
        { operationId: "two", dependsOnOperationId: "one" },
      ],
    ],
    [[{ ...one, dependsOn: ["two"] }, two], []],
    [
      [{ ...one, dependsOn: ["two"] }, two],
      [
        { operationId: "one", dependsOnOperationId: "two" },
        { operationId: "one", dependsOnOperationId: "two" },
      ],
    ],
  ];

  for (const [operations, dependencies] of cases) {
    expectAppError(
      () => topologicalOperationIds(operations, dependencies),
      "VALIDATION_ERROR",
    );
  }
});

test("hashes only strict executable content deterministically and sensitively", () => {
  const first = executable();
  const reordered = {
    dependencies: [],
    operations: [],
    protectedListIds: [],
    protectedRepositoryIds: [],
    snapshotId: "snap_1",
    binding: {
      accountId: "U_1",
      login: "octocat",
      host: "github.com",
    },
    policyVersion: "1",
    schemaVersion: 1,
  };
  expect(hashPlanExecutable(first)).toBe(hashPlanExecutable(reordered));

  const metadataA = {
    id: "plan_a",
    createdAt: "2026-07-16T00:00:00.000Z",
    callerNote: "a",
    executable: first,
  };
  const metadataB = {
    id: "plan_b",
    createdAt: "2026-07-17T00:00:00.000Z",
    callerNote: "b",
    executable: first,
  };
  expect(hashPlanExecutable(metadataA.executable)).toBe(
    hashPlanExecutable(metadataB.executable),
  );
  expectAppError(
    () => hashPlanExecutable({ ...first, callerNote: "must not be ignored" }),
    "VALIDATION_ERROR",
  );

  const mutations = [
    executable({ snapshotId: asSnapshotId("snap_2") }),
    executable({
      binding: { ...binding, accountId: "U_2" },
    }),
    executable({
      protectedRepositoryIds: [asRepositoryId("R_1")],
    }),
    executable({ operations: [createOperation()] }),
  ];
  for (const changed of mutations) {
    expect(hashPlanExecutable(changed)).not.toBe(hashPlanExecutable(first));
  }
});

test("parses a ChangePlan with identical executable views and verified hash", () => {
  const content = executable({
    operations: [createOperation()],
    dependencies: [],
  });
  const input: ChangePlan = {
    id: asPlanId("plan_1"),
    hash: hashPlanExecutable(content),
    state: "ready",
    createdAt: "2026-07-16T00:00:00Z",
    expiresAt: "2026-07-17T00:00:00Z",
    callerNote: "cleanup",
    executable: content,
    operations: [...content.operations],
    dependencies: [...content.dependencies],
    warnings: ["Review destructive changes"],
  };
  const plan = parseChangePlan(input);

  expect(plan.createdAt).toBe("2026-07-16T00:00:00.000Z");
  expect(plan.expiresAt).toBe("2026-07-17T00:00:00.000Z");
  expect(plan.operations).toBe(plan.executable.operations);
  expect(plan.dependencies).toBe(plan.executable.dependencies);
  expect(Object.isFrozen(plan)).toBe(true);
  expect(Object.isFrozen(plan.warnings)).toBe(true);
});

test("ChangePlan rejects mismatched duplicated views and hashes", () => {
  const content = executable({ operations: [createOperation()] });
  const base = {
    id: "plan_1",
    hash: hashPlanExecutable(content),
    state: "ready",
    createdAt: "2026-07-16T00:00:00.000Z",
    expiresAt: "2026-07-17T00:00:00.000Z",
    callerNote: null,
    executable: content,
    operations: content.operations,
    dependencies: content.dependencies,
    warnings: [],
  };
  expectAppError(
    () => parseChangePlan({ ...base, operations: [] }),
    "VALIDATION_ERROR",
  );
  expectAppError(
    () =>
      parseChangePlan({
        ...base,
        dependencies: [{ operationId: "x", dependsOnOperationId: "y" }],
      }),
    "VALIDATION_ERROR",
  );
  expectAppError(
    () => parseChangePlan({ ...base, hash: "f".repeat(64) }),
    "PLAN_HASH_MISMATCH",
  );
  expectAppError(
    () => parseChangePlan({ ...base, hash: "F".repeat(64) }),
    "VALIDATION_ERROR",
  );
  expectAppError(
    () =>
      parseChangePlan({
        ...base,
        expiresAt: "2026-07-15T00:00:00.000Z",
      }),
    "VALIDATION_ERROR",
  );
});

test("plan transition table accepts only specified directed edges", () => {
  const states: readonly PlanState[] = [
    "ready",
    "applying",
    "applied",
    "partial",
    "expired",
    "failed",
    "superseded",
  ];
  const allowed = new Set([
    "ready>applying",
    "ready>expired",
    "ready>superseded",
    "applying>applied",
    "applying>partial",
    "applying>failed",
    "partial>applying",
  ]);

  for (const from of states) {
    for (const to of states) {
      if (allowed.has(`${from}>${to}`)) {
        expect(transitionPlanState(from, to)).toBe(to);
      } else {
        expectAppError(
          () => transitionPlanState(from, to),
          "PRECONDITION_FAILED",
        );
      }
    }
  }
  expectAppError(
    () => transitionPlanState("unknown" as PlanState, "ready"),
    "PRECONDITION_FAILED",
  );
});

test("parses ChangeRun and enforces run finishedAt invariants", () => {
  for (const state of ["pending", "running"] as const) {
    const run = parseChangeRun({
      id: "run_1",
      planId: "plan_1",
      binding,
      state,
      failureMode: "stop",
      warnings: ["safe"],
      startedAt: "2026-07-16T00:00:00Z",
      finishedAt: null,
    });
    expect(run.startedAt).toBe("2026-07-16T00:00:00.000Z");
    expect(Object.isFrozen(run.binding)).toBe(true);
    expect(Object.isFrozen(run.warnings)).toBe(true);
  }

  for (const state of ["completed", "partial", "failed"] as const) {
    expect(
      parseChangeRun({
        id: "run_1",
        planId: "plan_1",
        binding,
        state,
        failureMode: "continue",
        warnings: [],
        startedAt: "2026-07-16T00:00:00.000Z",
        finishedAt: "2026-07-16T01:00:00Z",
      }).finishedAt,
    ).toBe("2026-07-16T01:00:00.000Z");
  }

  expectAppError(
    () =>
      parseChangeRun({
        id: "run_1",
        planId: "plan_1",
        binding,
        state: "running",
        failureMode: "stop",
        warnings: [],
        startedAt: "2026-07-16T00:00:00.000Z",
        finishedAt: "2026-07-16T01:00:00.000Z",
      }),
    "VALIDATION_ERROR",
  );
  expectAppError(
    () =>
      parseChangeRun({
        id: "run_1",
        planId: "plan_1",
        binding,
        state: "completed",
        failureMode: "stop",
        warnings: [],
        startedAt: "2026-07-16T00:00:00.000Z",
        finishedAt: null,
      }),
    "VALIDATION_ERROR",
  );
});

test("parses and freezes RunOperation including serialized errors", () => {
  const operation = parseRunOperation({
    runId: "run_1",
    operationId: "op_1",
    sequence: 0,
    status: "failed",
    reconciliation: "confirmed_not_applied",
    attempts: 1,
    before: { starred: false },
    after: { starred: false },
    externalRequestId: "req_1",
    error: {
      code: "RECONCILIATION_REQUIRED",
      message: "confirmed not applied",
      retryable: true,
      details: { reason: "before_state" },
    },
    startedAt: "2026-07-16T00:00:00Z",
    finishedAt: "2026-07-16T00:00:01Z",
  });

  expect(operation.startedAt).toBe("2026-07-16T00:00:00.000Z");
  expect(operation.finishedAt).toBe("2026-07-16T00:00:01.000Z");
  expect(Object.isFrozen(operation)).toBe(true);
  expect(Object.isFrozen(operation.error)).toBe(true);
  expect(Object.isFrozen(operation.error?.details)).toBe(true);
});

test("RunOperation rejects unsafe counts, extras, bad errors, and timestamp states", () => {
  const base = {
    runId: "run_1",
    operationId: "op_1",
    sequence: 0,
    status: "pending",
    reconciliation: "not_required",
    attempts: 0,
    before: null,
    after: null,
    externalRequestId: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
  const invalid = [
    { ...base, sequence: -1 },
    { ...base, sequence: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, attempts: -1 },
    { ...base, extra: true },
    { ...base, status: "unknown" },
    { ...base, startedAt: "2026-07-16T00:00:00.000Z" },
    {
      ...base,
      status: "running",
      attempts: 1,
      startedAt: null,
    },
    {
      ...base,
      status: "running",
      attempts: 1,
      startedAt: "2026-07-16T00:00:00.000Z",
      finishedAt: "2026-07-16T00:00:01.000Z",
    },
    {
      ...base,
      status: "succeeded",
      attempts: 1,
      startedAt: "2026-07-16T00:00:00.000Z",
      finishedAt: null,
    },
    {
      ...base,
      error: {
        code: "NOT_A_CODE",
        message: "bad",
        retryable: false,
        details: {},
      },
    },
    {
      ...base,
      error: {
        code: "INTERNAL_ERROR",
        message: "bad",
        retryable: false,
        details: {},
        secret: "hidden",
      },
    },
  ];
  for (const input of invalid) {
    expectAppError(() => parseRunOperation(input), "VALIDATION_ERROR");
  }
});

test("attempt and reconciliation parsers enforce their closed lifecycle matrices", () => {
  const runningAttempt = {
    runId: "run_1",
    operationId: "op_1",
    attempt: 1,
    before: { starred: true },
    startedAt: "2026-07-16T00:00:00.000Z",
    status: "running",
    reconciliation: "pending",
    after: null,
    externalRequestId: null,
    error: null,
    finishedAt: null,
  };
  expect(parseRunOperationAttempt(runningAttempt).status).toBe("running");
  expect(Object.isFrozen(parseRunOperationAttempt(runningAttempt))).toBe(true);
  for (const invalid of [
    { ...runningAttempt, attempt: 0 },
    { ...runningAttempt, status: "skipped", reconciliation: "not_required" },
    { ...runningAttempt, after: { starred: false } },
    {
      ...runningAttempt,
      status: "unresolved",
      reconciliation: "unknown",
      error: {
        code: "RECONCILIATION_REQUIRED",
        message: "unknown",
        retryable: true,
        details: {},
      },
      finishedAt: "2026-07-16T00:01:00.000Z",
    },
  ]) {
    expectAppError(() => parseRunOperationAttempt(invalid), "VALIDATION_ERROR");
  }

  const confirmed = {
    runId: "run_1",
    operationId: "op_1",
    attempt: 1,
    eventSequence: 1,
    after: { starred: true },
    observedAt: "2026-07-16T00:02:00.000Z",
    status: "failed",
    reconciliation: "confirmed_not_applied",
    error: {
      code: "GITHUB_UNAVAILABLE",
      message: "not applied",
      retryable: true,
      details: {},
    },
  };
  expect(parseRunOperationReconciliation(confirmed).status).toBe("failed");
  for (const invalid of [
    { ...confirmed, eventSequence: -1 },
    { ...confirmed, eventSequence: 0 },
    { ...confirmed, error: { ...confirmed.error, retryable: false } },
    {
      ...confirmed,
      status: "succeeded",
      reconciliation: "confirmed_applied",
    },
    { ...confirmed, status: "skipped" },
  ]) {
    expectAppError(
      () => parseRunOperationReconciliation(invalid),
      "VALIDATION_ERROR",
    );
  }
});

test("all runtime parsers reject accessors without invoking them", () => {
  const parsers = [
    parsePlanRequest,
    parsePlanExecutable,
    parseChangePlan,
    parseChangeRun,
    parseRunOperation,
  ] as const;
  for (const parser of parsers) {
    let calls = 0;
    const hostile = {};
    Object.defineProperty(hostile, "payload", {
      enumerable: true,
      get() {
        calls += 1;
        return "ghp_secret";
      },
    });
    expectAppError(() => parser(hostile), "VALIDATION_ERROR");
    expect(calls).toBe(0);
  }
});

test("normal run transitions exclude the startup recovery edge", () => {
  const states: readonly RunState[] = [
    "pending",
    "running",
    "completed",
    "partial",
    "failed",
  ];
  const allowed = new Set([
    "pending>running",
    "running>completed",
    "running>partial",
    "running>failed",
    "partial>running",
  ]);

  for (const from of states) {
    for (const to of states) {
      if (allowed.has(`${from}>${to}`)) {
        expect(transitionRunState(from, to)).toBe(to);
      } else {
        expectAppError(
          () => transitionRunState(from, to),
          "PRECONDITION_FAILED",
        );
      }
    }
  }

  expect(recoverRunState("pending")).toBe("partial");
  expect(recoverRunState("running")).toBe("partial");
  expectAppError(
    () => recoverRunState("partial" as "pending"),
    "PRECONDITION_FAILED",
  );
});

test("branded runtime values are returned through the exact public types", () => {
  const plan = parseChangePlan({
    id: "plan_1",
    hash: hashPlanExecutable(executable()),
    state: "ready",
    createdAt: "2026-07-16T00:00:00.000Z",
    expiresAt: "2026-07-17T00:00:00.000Z",
    callerNote: null,
    executable: executable(),
    operations: [],
    dependencies: [],
    warnings: [],
  });
  const run = parseChangeRun({
    id: "run_1",
    planId: "plan_1",
    binding,
    state: "pending",
    failureMode: "stop",
    warnings: [],
    startedAt: "2026-07-16T00:00:00.000Z",
    finishedAt: null,
  });

  expect(plan.id).toBe(asPlanId("plan_1"));
  expect(run.id).toBe(asRunId("run_1"));
});
