# Change Plan, Apply, Rollback, and Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task by task. Every task is test-first and ends in a focused commit.

**Goal:** Build the immutable change planner, closed GitHub Star/User List mutation boundary, serial and resumable apply engine, operation-specific reconciliation, dependency-safe rollback-plan generator, and bounded audit inspection required for an AI agent to manage Stars without repository-administration authority.

**Architecture:** `PlanService`, `ApplyService`, `RollbackService`, and `InspectService` depend only on the named `GitHubPort` and synchronous `StoragePort`. Planning resolves all selectors and membership deltas against one complete snapshot and persists canonical executable content once. Apply verifies the persisted content, authenticated account, capability, expiry, and global account lease before claiming a run. Every external mutation has a durable write-ahead row, stable-ID precondition, postcondition, one-at-a-time pacing, and explicit reconciliation. Rollback projects only successful source operations into a new immutable plan and never mutates GitHub.

**Tech Stack:** Node.js 22/24, TypeScript 6.0.3 strict ESM, Octokit 5.0.5, `better-sqlite3` behind `StoragePort`, Node `crypto`, Vitest v4.

## Locked Dependencies from Plans 01 and 02

Plan 01 owns these contracts; do not recreate or rename them:

- `Repository.repositoryId`, `Repository.repositoryDatabaseId`, `Repository.stargazerCount`, and `UserList.listId`.
- `Snapshot.binding`, where `binding` is exact `host`, `login`, and stable `accountId`.
- `PlanRequest.actions`, all six `ResolvedOperation` variants, `PlanExecutableContent`, `ChangePlan`, `ChangeRun`, `RunOperation`, `hashPlanExecutable`, `topologicalOperationIds`, and `reverseDependencyOperationIds`.
- `StoragePort`, `StorageTransaction`, `SQLiteStore`, and `test/fixtures/memory-storage.ts#createMemoryStorage`.
- `createRunOperation`, `startRunOperation`, `finishRunOperation`,
  `reconcileRunOperation`, and `retryRunOperation`: create writes `pending`
  attempt zero, start is the sole active-lease `pending→running` CAS and
  appends an immutable per-dispatch attempt immediately before transport,
  finish/reconcile update only legal discriminated outcomes, and retry queues
  only `failed + confirmed_not_applied + retryable` within the attempt ceiling
  while preserving all earlier attempts, successful rows, and original
  `before`.

Plan 02 owns the read side of `GitHubPort`, the adapter, the allowlisted
transport, the heartbeat-driven `LeaseScope`, and the shared scripted seam:

```ts
createScriptedGitHubAdapter(
  transcript: readonly ScriptedGitHubStep[],
  host?: string,
): {
  adapter: OctokitGitHubAdapter;
  requests: ScriptedRequest[];
  graphqlVariables(operation: string): Readonly<Record<string, unknown>>;
  graphqlDocuments(): readonly string[];
};
```

This plan extends those files. It does not expose a generic request, URL, HTTP verb, raw GraphQL document, shell command, SQL statement, or repository-administration method.

## Global Safety Rules

- Version 1 accepts only `github.com`; every snapshot, plan, run, cursor, and account-scoped lease is bound to exact identity.
- The public planning input never accepts an account binding. `PlanService` derives it from the complete snapshot.
- Repository coordinates are routing data only. Every Star mutation verifies both the live GraphQL node ID and decimal REST database ID immediately before dispatch.
- User List mutation identity is always its GraphQL `listId`.
- Default plan expiry is 1,440 minutes. No caller may raise the configured 5,000-operation ceiling.
- Hash only `PlanExecutableContent`; exclude plan ID, lifecycle timestamps, caller note, summaries, and warnings.
- Read-only mode is the default. Admission failure must not change plan/run state or create a run.
- Never keep `StoragePort.withTransaction` open across `await`.
- Never automatically retry a mutation transport dispatch. A reset after dispatch is ambiguous and must be read back before a later attempt.
- Keep one account apply lease for the whole run and keep it through the final pacing window. This provides cross-process serialization and at least the configured 1,000 ms between mutation starts.
- Write the `pending` audit row before entering the mutation pacer. Inside the
  paced callback, check `AbortSignal`, atomically mark it `running` and append
  its attempt under the current exact-owner lease, and then dispatch
  immediately with no intervening `await`. Pass the signal through the pacer
  and executor.
- A resume reuses the same run ID, never rewrites a successful row, and uses `retryRunOperation` rather than reinserting a write-ahead row.
- Descriptions, names, README text, GitHub errors, and headers are inert untrusted data and are recursively redacted before persistence or output.
- Rollback creation is closed-world and reads only persisted plan/run audit data. The resulting plan remains bound to the source run account, and the later apply step performs the live viewer/capability check. Re-starring cannot restore `starred_at`; List recreation cannot restore the former List ID.

## File Map

- `src/app/ports/github-port.ts`: named live state reads and six mutation methods.
- `src/github/allowed-operations.ts`: frozen REST/GraphQL allowlists and exported mutation-method manifest.
- `src/github/octokit-client.ts`: separate retryable reads and exactly-once mutation dispatch.
- `src/github/octokit-github-adapter.ts`: fixed routes/documents, normalization, complete membership traversal, and request IDs.
- `src/github/user-list-mutations.ts`: four fixed mutation documents.
- `src/github/errors.ts`: `AmbiguousMutationError`.
- `src/app/services/plan-service.ts`, `operation-resolver.ts`: deterministic resolution and persistence.
- `src/app/services/mutation-pacer.ts`, `mutation-executor.ts`: cancellation-aware spacing and stable-ID state transitions.
- `src/app/services/apply-service.ts`: admission, lease, write-ahead audit, dependency gating, bounded result, and resume.
- `src/app/services/reconciliation.ts`: exhaustive operation-specific ambiguity classification.
- `src/app/services/rollback-service.ts`: successful induced-subgraph inversion and one-to-many projections.
- `src/app/services/inspect-service.ts`: target-bound cursor paging and redaction.
- `test/support/change-service-fixtures.ts`: coherent builders/fakes shared by Tasks 2–7.
- `test/contract/github/mutations.test.ts`: exact network behavior.
- `test/unit/services/*.test.ts`: planner, executor, apply, reconciliation, rollback, and inspect behavior.
- `test/security/github-capability-boundary.test.ts`: executable allowlist and source-boundary proof.
- `test/unit/live-contract-config.test.ts`: deterministic environment-guard tests.
- `test/live/disposable-account.contract.test.ts`: manually enabled disposable-account observation.

---

### Task 1: Extend the closed GitHub boundary with live state reads and mutations

**Files:**

- Modify: `src/app/ports/github-port.ts`
- Modify: `src/github/allowed-operations.ts`
- Modify: `src/github/octokit-client.ts`
- Modify: `src/github/octokit-github-adapter.ts`
- Modify: `test/support/scripted-github-adapter.ts`
- Create: `src/github/user-list-mutations.ts`
- Create: `src/github/errors.ts`
- Create: `test/contract/github/mutations.test.ts`

**Produces:**

```ts
export type MutationReceipt = Readonly<{
  requestId: string | null;
  clientMutationId: string | null;
}>;

export type RepositoryIdentity = Readonly<{
  repositoryId: RepositoryId;
  repositoryDatabaseId: RepositoryDatabaseId;
  coordinates: RepositoryCoordinates;
}>;

export type CreateUserListInput = Readonly<{
  name: string;
  description: string | null;
  isPrivate: boolean;
}>;

export type UpdateUserListInput = Readonly<{
  name?: string;
  description?: string | null;
  isPrivate?: boolean;
}>;

export type UserListMutationResult = Readonly<{
  list: GitHubUserList;
  receipt: MutationReceipt;
}>;

export interface GitHubPort {
  // Retain every Plan 02 method unchanged.
  getRepositoryIdentity(repository: RepositoryCoordinates, signal?: AbortSignal): Promise<RepositoryIdentity | null>;
  getUserList(listId: UserListId, signal?: AbortSignal): Promise<GitHubUserList | null>;
  checkStar(repository: RepositoryCoordinates, signal?: AbortSignal): Promise<boolean>;
  getRepositoryListIds(repositoryId: RepositoryId, signal?: AbortSignal): Promise<readonly UserListId[]>;
  star(repository: RepositoryCoordinates, operationId: string, signal?: AbortSignal): Promise<MutationReceipt>;
  unstar(repository: RepositoryCoordinates, operationId: string, signal?: AbortSignal): Promise<MutationReceipt>;
  createUserList(input: CreateUserListInput, operationId: string, signal?: AbortSignal): Promise<UserListMutationResult>;
  updateUserList(listId: UserListId, input: UpdateUserListInput, operationId: string, signal?: AbortSignal): Promise<UserListMutationResult>;
  deleteUserList(listId: UserListId, operationId: string, signal?: AbortSignal): Promise<MutationReceipt>;
  setRepositoryListIds(repositoryId: RepositoryId, listIds: readonly UserListId[], operationId: string, signal?: AbortSignal): Promise<MutationReceipt>;
}
```

- [ ] **Step 1: Write failing transport and adapter contracts**

Create contract tests with these exact cases:

1. `getRepositoryIdentity` uses only fixed `GET /repos/{owner}/{repo}` and maps `node_id` plus decimal `id`.
2. `checkStar` maps fixed `GET /user/starred/{owner}/{repo}` statuses `204 -> true`, `404 -> false`, and rejects every other status.
3. `star` dispatches fixed `PUT /user/starred/{owner}/{repo}` once, with no body and `content-length: 0`; `unstar` dispatches fixed `DELETE` once.
4. All four GraphQL mutations use the fixed operation names below, pass `operationId` as `clientMutationId`, and return `x-github-request-id` when present.
5. Membership IDs are sorted and deduplicated before `UpdateUserListsForItem`.
6. An empty `UpdateUserListInput` fails with `VALIDATION_ERROR` before a request is recorded.
7. Any top-level or partial GraphQL `errors` array fails; partial `data` is never treated as success.
8. A connection reset after mutation dispatch produces `AmbiguousMutationError` and the scripted transcript records exactly one dispatch.
9. Mutation dispatch ignores the read retry policy; throttling/rate-limit responses are classified without replay.
10. `getUserList` uses a fixed node query and returns `null` only for a missing node.
11. `getRepositoryListIds` exhausts every `viewer.lists` page and every List `items` page before returning sorted unique IDs containing the repository.
12. Request IDs and sanitized GitHub errors survive the adapter mapping without authorization/token values.

The core request assertion is:

```ts
const repositoryId = asRepositoryId("R_repo");
const listA = asUserListId("UL_A");
const listB = asUserListId("UL_B");
const scripted = createScriptedGitHubAdapter([
  {
    graphqlOperation: "UpdateUserListsForItem",
    data: {
      updateUserListsForItem: {
        item: { __typename: "Repository", id: "R_repo" },
        lists: [{ id: "UL_A" }, { id: "UL_B" }],
        clientMutationId: "op_membership",
      },
    },
    headers: { "x-github-request-id": "LIST-1" },
  },
]);

await scripted.adapter.setRepositoryListIds(
  repositoryId,
  [listB, listA, listB],
  "op_membership",
);

expect(scripted.graphqlVariables("UpdateUserListsForItem")).toEqual({
  itemId: "R_repo",
  listIds: ["UL_A", "UL_B"],
  clientMutationId: "op_membership",
});
expect(scripted.requests).toHaveLength(1);
```

- [ ] **Step 2: Prove the extension is absent**

Run:

```bash
npm test -- test/contract/github/mutations.test.ts
```

Expected: FAIL on missing port methods, mutation documents, or mutation transcript variants.

- [ ] **Step 3: Implement fixed documents and a non-retrying mutation transport**

Add exactly these mutation documents to `src/github/user-list-mutations.ts`:

```ts
export const CREATE_USER_LIST = `mutation CreateUserList($name: String!, $description: String, $isPrivate: Boolean!, $clientMutationId: String!) {
  createUserList(input: { name: $name, description: $description, isPrivate: $isPrivate, clientMutationId: $clientMutationId }) {
    list { id name slug description isPrivate createdAt updatedAt lastAddedAt }
    clientMutationId
  }
}` as const;

export const UPDATE_USER_LIST = `mutation UpdateUserList($listId: ID!, $name: String, $description: String, $isPrivate: Boolean, $clientMutationId: String!) {
  updateUserList(input: { listId: $listId, name: $name, description: $description, isPrivate: $isPrivate, clientMutationId: $clientMutationId }) {
    list { id name slug description isPrivate createdAt updatedAt lastAddedAt }
    clientMutationId
  }
}` as const;

export const DELETE_USER_LIST = `mutation DeleteUserList($listId: ID!, $clientMutationId: String!) {
  deleteUserList(input: { listId: $listId, clientMutationId: $clientMutationId }) {
    clientMutationId
  }
}` as const;

export const SET_REPOSITORY_LISTS = `mutation UpdateUserListsForItem($itemId: ID!, $listIds: [ID!]!, $clientMutationId: String!) {
  updateUserListsForItem(input: { itemId: $itemId, listIds: $listIds, clientMutationId: $clientMutationId }) {
    item { __typename ... on Repository { id } }
    lists { id }
    clientMutationId
  }
}` as const;
```

In `allowed-operations.ts`:

- Add the fixed repository-identity REST read key.
- Export frozen fixed GraphQL read keys for one List and paginated List membership.
- Export fixed REST mutation keys `star` and `unstar`.
- Export fixed GraphQL mutation keys `createUserList`, `updateUserList`, `deleteUserList`, and `setRepositoryListIds`.
- Export `GITHUB_MUTATION_METHOD_NAMES`, frozen and checked with `satisfies readonly (keyof GitHubPort)[]`.

In `octokit-client.ts`, keep retry/throttle behavior for reads, but route mutations through distinct `restMutation` and `graphqlMutation` methods that execute the underlying request exactly once. Map a reset/timeout after dispatch to:

```ts
export class AmbiguousMutationError extends AppError {
  constructor(
    readonly operationId: string,
    readonly mutationName: string,
    cause: unknown,
  ) {
    super(
      "RECONCILIATION_REQUIRED",
      `Mutation ${mutationName} has an unknown outcome.`,
      { retryable: false, details: { operationId, mutationName }, cause },
    );
  }
}
```

The adapter must:

- Accept no caller-supplied path, verb, URL, or GraphQL document.
- Capture response headers for REST and GraphQL.
- Reject partial GraphQL errors before normalization.
- Implement `getRepositoryListIds` by looping `listUserLists(cursor)` to `nextCursor === null`, then looping `listUserListItems(listId, cursor)` for every List to exhaustion. Do not infer membership from a cached reverse field.
- Return sorted unique IDs.

Extend the scripted seam's REST method union with `PUT | DELETE`, GraphQL steps with optional `headers`, and reset-after-dispatch behavior without changing its constructor.

- [ ] **Step 4: Verify exact dispatch and type safety**

Run:

```bash
npm test -- test/contract/github/mutations.test.ts test/security/github-read-boundary.test.ts
npm run typecheck
npm run lint
```

Expected: all contracts pass; a reset test records one dispatch; the read boundary remains closed.

- [ ] **Step 5: Commit**

```bash
git add src/app/ports/github-port.ts src/github/allowed-operations.ts src/github/octokit-client.ts src/github/octokit-github-adapter.ts src/github/user-list-mutations.ts src/github/errors.ts test/support/scripted-github-adapter.ts test/contract/github/mutations.test.ts
git commit -m "feat: add closed GitHub mutation boundary"
```

### Task 2: Resolve and persist deterministic immutable plans

**Files:**

- Create: `src/app/services/plan-service.ts`
- Create: `src/app/services/operation-resolver.ts`
- Create: `test/support/change-service-fixtures.ts`
- Create: `test/unit/services/plan-service.test.ts`

**Produces:**

```ts
export type CreatePlanInput = PlanRequest;
export type CreatePlanResult = Readonly<{
  plan: ChangePlan;
  summary: Readonly<Record<ResolvedOperation["kind"], number>>;
}>;

export class PlanService {
  create(input: CreatePlanInput): Promise<CreatePlanResult>;
}
```

The shared fixture module exports `seedCompleteSnapshot`, `repositoryFixture`, `userListFixture`, `plannerFixture`, `applyFixture`, `rollbackFixture`, `inspectFixture`, `fakeGitHub`, and `fakeMonotonicTime`. It imports `createMemoryStorage` only from `test/fixtures/memory-storage.ts`. Every repository builder supplies `repositoryId`, `repositoryDatabaseId`, `stargazerCount`, and the remaining normalized Plan 01 fields; every List builder supplies `listId` and all normalized fields.

- [ ] **Step 1: Write failing planner and fixture tests**

```ts
it("derives binding, protects IDs, and turns membership add into one complete set", async () => {
  const fixture = plannerFixture();
  const result = await fixture.service.create({
    snapshotId: fixture.snapshot.id,
    actions: [
      {
        kind: "unstar",
        repositories: {
          kind: "filter",
          filter: { field: "stargazer_count", op: "lt", value: 100 },
        },
      },
      {
        kind: "list_membership_add",
        repositories: { kind: "ids", repositoryIds: [fixture.ids.removeRepository] },
        lists: [{ kind: "existing", listId: fixture.ids.addList }],
      },
    ],
    protectedRepositoryIds: [fixture.ids.keepRepository],
    protectedListIds: [],
    callerNote: "cleanup",
  });

  expect(result.plan.executable.binding).toEqual(fixture.snapshot.binding);
  expect(result.plan.operations).toMatchObject([
    { operationId: "op_000001", kind: "unstar", repositoryId: fixture.ids.removeRepository },
    {
      operationId: "op_000002",
      kind: "list_membership_set",
      repositoryId: fixture.ids.removeRepository,
      expectedListIds: [fixture.ids.existingList],
      targetLists: [
        { kind: "existing", listId: fixture.ids.addList },
        { kind: "existing", listId: fixture.ids.existingList },
      ],
    },
  ]);
  expect(fixture.storage.savedPlans()).toEqual([result.plan]);
});

it("uses stable local operation IDs and hashes identical executable content identically", async () => {
  const first = plannerFixture();
  const second = plannerFixture();
  const a = await first.service.create(first.validInput);
  const b = await second.service.create(second.validInput);
  expect(a.plan.id).not.toBe(b.plan.id);
  expect(a.plan.executable).toEqual(b.plan.executable);
  expect(a.plan.hash).toBe(b.plan.hash);
});
```

Also test:

- All `queryRepositories`, `queryLists`, and `queryListMemberships` cursors are
  exhausted without ever requesting an unbounded member array.
- Any action that reads or mutates Lists requires snapshot
  `listCoverage:"complete"`; `unavailable`, `omitted`, and `collecting` fail
  before a plan is saved. A Star-only plan remains valid on final non-List
  coverage.
- Missing stable IDs, incomplete/failed snapshots, conflicts, and graph cycles save no plan.
- Protected repositories emit no operation.
- Protected Lists cannot be updated/deleted and cannot be removed by membership delta; their existing membership is preserved.
- Exact duplicate actions collapse before IDs are assigned.
- `list_create` captures the complete live-snapshot List-ID baseline in `before` for later ambiguity detection.
- `list_delete.before` contains full List metadata and all member repository IDs.
- Caller TTL is positive and at most the configured TTL; caller `maxOperations` can lower but never raise the configured ceiling.
- `PLAN_TOO_LARGE` uses `new AppError(code, message, { retryable: false })`.

- [ ] **Step 2: Prove services and shared fixtures are absent**

Run:

```bash
npm test -- test/unit/services/plan-service.test.ts
```

Expected: FAIL resolving `plan-service.ts`, `operation-resolver.ts`, or the shared fixture.

- [ ] **Step 3: Implement full deterministic resolution**

`resolveOperationRequests` receives `{ storage, snapshot, actions, protectedRepositoryIds, protectedListIds, nextOperationId }`. It must:

1. Page every selector to exhaustion against `snapshot.id`. For List
   metadata use `queryLists`; for deletion before-state and per-repository
   membership use the appropriate bounded `queryListMemberships` direction.
2. Resolve and sort repository and List targets by stable ID; expand a multi-ID `list_update` request to one resolved operation per List.
3. Remove protected targets and preserve protected membership before assigning operation IDs.
4. Normalize add/remove/set membership actions per repository into one exact sorted set.
5. Use `expectedListIds` for the snapshot precondition and `targetLists` for the desired complete set.
6. Resolve request-time `{ kind: "created", clientRef }` references to exactly one matching `list_create`, convert them to `{ kind: "created", createOperationId }`, reject missing/duplicate references, and add create-before-membership dependencies.
7. Snapshot full before/after/inverse JSON for every operation.
8. Collapse exact duplicates and reject incompatible changes to the same target.
9. Assign `op_000001`, `op_000002`, and later IDs only after deterministic sorting.

`PlanService.create` then builds:

```ts
const executable: PlanExecutableContent = {
  schemaVersion: 1,
  policyVersion: "1",
  binding: snapshot.binding,
  snapshotId: snapshot.id,
  protectedRepositoryIds: sortedUnique(input.protectedRepositoryIds),
  protectedListIds: sortedUnique(input.protectedListIds),
  operations,
  dependencies,
};

const plan: ChangePlan = {
  id: ids.planId(),
  hash: hashPlanExecutable(executable),
  state: "ready",
  createdAt,
  expiresAt: addMinutes(createdAt, effectiveTtlMinutes),
  callerNote: input.callerNote ?? null,
  executable,
  operations,
  dependencies,
  warnings: planWarnings(operations),
};
```

Call `topologicalOperationIds` before `savePlan`, save once inside one synchronous transaction, and never accept or compare a caller account binding.

- [ ] **Step 4: Verify planner, domain graph, and hash**

Run:

```bash
npm test -- test/unit/services/plan-service.test.ts test/unit/domain/plan-run.test.ts
npm run typecheck
npm run lint
```

Expected: deterministic executable/hash tests pass and invalid input leaves no plan.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/plan-service.ts src/app/services/operation-resolver.ts test/support/change-service-fixtures.ts test/unit/services/plan-service.test.ts
git commit -m "feat: resolve immutable change plans"
```

### Task 3: Enforce live preconditions, cancellation, and mutation pacing

**Files:**

- Create: `src/app/services/mutation-pacer.ts`
- Create: `src/app/services/mutation-executor.ts`
- Modify: `test/support/change-service-fixtures.ts`
- Create: `test/unit/services/mutation-pacer.test.ts`
- Create: `test/unit/services/mutation-executor.test.ts`

**Produces:**

```ts
export type ExecutionContext = {
  readonly createdListIdsByOperationId: Map<string, UserListId>;
};

export class MutationPacer {
  run<TPrepared,TResult>(input:{
    readonly signal?:AbortSignal;
    readonly prepare:()=>Promise<
      | {readonly kind:"skipped";readonly outcome:ExecutionOutcome}
      | {readonly kind:"dispatch";readonly prepared:TPrepared}
    >;
    readonly dispatch:(prepared:TPrepared)=>Promise<TResult>;
  }):Promise<ExecutionOutcome|TResult>;
  waitForSafetyWindow(): Promise<void>;
}

export interface PreparedMutation {
  readonly operation:ResolvedOperation;
  readonly before:JsonValue;
  readonly mutation:AllowlistedPreparedMutation;
}
export class MutationExecutor {
  readCurrentState(
    operation: ResolvedOperation,
    context: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<JsonValue>;
  matchesBefore(operation: ResolvedOperation, state: JsonValue, context: ExecutionContext): boolean;
  matchesAfter(operation: ResolvedOperation, state: JsonValue, context: ExecutionContext): boolean;
  prepare(
    operation: ResolvedOperation,
    context: ExecutionContext,
    signal?: AbortSignal,
  ): Promise<{readonly kind:"skipped";readonly outcome:ExecutionOutcome}|{readonly kind:"dispatch";readonly prepared:PreparedMutation}>;
  dispatchPrepared(
    prepared:PreparedMutation,
    context:ExecutionContext,
    signal?:AbortSignal,
  ):Promise<ExecutionOutcome>;
}
```

- [ ] **Step 1: Write failing pacing and stable-identity tests**

Test all of the following:

- Three concurrent `MutationPacer.run` calls start at monotonic times `0`, `1000`, and `2000` and maximum concurrency is one.
- Aborting during queued sleep rejects without calling the supplied mutation.
- `waitForSafetyWindow` waits through the final interval even if the caller's signal is aborted.
- A repository at the expected coordinates with a different node ID or database ID fails `PRECONDITION_FAILED` before `star`/`unstar`.
- A changed List fails update/delete preconditions.
- A changed complete membership set fails before `setRepositoryListIds`.
- An already-desired state returns `skipped` with zero mutation calls.
- `list_create` stores the returned `list.listId` under its create operation ID.
- `prepare` checks `signal`, re-reads the live stable precondition, and returns
  skipped or an opaque prepared allowlisted mutation without dispatch.
- `dispatchPrepared` is a non-`async` entry that invokes the one named GitHub
  mutation synchronously before returning its Promise; a scripted transport
  records the request before the method returns.

The membership assertion uses Plan 01 names:

```ts
await expect(executor.prepare({
  operationId: "op_000001",
  kind: "list_membership_set",
  repositoryId: asRepositoryId("R_1"),
  repositoryDatabaseId: asRepositoryDatabaseId("101"),
  coordinates: { owner: "acme", name: "widget" },
  expectedListIds: [asUserListId("UL_expected")],
  targetLists: [{ kind: "existing", listId: asUserListId("UL_new") }],
  dependsOn: [],
  preconditions: [],
  before: { listIds: ["UL_expected"] },
  after: { listIds: ["UL_new"] },
  inverse: { listIds: ["UL_expected"] },
  risk: "normal",
}, emptyExecutionContext())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
```

- [ ] **Step 2: Prove pacer and executor are absent**

Run:

```bash
npm test -- test/unit/services/mutation-pacer.test.ts test/unit/services/mutation-executor.test.ts
```

Expected: FAIL resolving the two service modules.

- [ ] **Step 3: Implement FIFO pacing and exact live state transitions**

`MutationPacer` maintains a promise tail and monotonic `lastStart`. Its queued callback:

1. Throws if aborted.
2. Sleeps interruptibly until `lastStart + intervalMs` when a previous
   mutation exists.
3. Throws if aborted, then calls and awaits the final `prepare` while retaining
   the serial queue.
4. If prepare returns skipped, returns it without changing `lastStart`.
5. Otherwise throws if aborted, records the fresh actual mutation-start time,
   and immediately calls exactly one `dispatch` callback.

Waiting before the final live read ensures no pacing sleep can stale the
precondition. A skipped operation after a mutation may wait once for the
remaining safety window, but because it does not move `lastStart`, consecutive
skips do not add artificial one-second intervals.

`waitForSafetyWindow` is non-cancellable and waits until `lastStart + intervalMs`, so an account lease cannot be released early.

For every Star operation, `MutationExecutor` calls `getRepositoryIdentity(coordinates)` and requires both stored IDs to match before reading/writing Star state. For Lists it calls `getUserList(listId)`. For membership it calls the fully paginated `getRepositoryListIds(repositoryId)`. It compares sorted exact state, not subset membership.

`prepare` performs the final identity/state read, returns `skipped` if desired
state already holds, and throws `PRECONDITION_FAILED` if the exact before state
does not hold. No attempt exists yet. `dispatchPrepared` contains no `await`
before its named mutation call; it invokes that transport synchronously, then
chains the response and exact after-state read. A successful response without
the after state throws `RECONCILIATION_REQUIRED`. Prepared values are frozen,
opaque, single-use, bound to the operation/context, and cannot carry a generic
route or GraphQL document.

- [ ] **Step 4: Verify focused execution behavior**

Run:

```bash
npm test -- test/unit/services/mutation-pacer.test.ts test/unit/services/mutation-executor.test.ts
npm run typecheck
npm run lint
```

Expected: pacing, cancellation, stable identity, complete membership, and no-write-on-stale tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/mutation-pacer.ts src/app/services/mutation-executor.ts test/support/change-service-fixtures.ts test/unit/services/mutation-pacer.test.ts test/unit/services/mutation-executor.test.ts
git commit -m "feat: enforce mutation preconditions and pacing"
```

### Task 4: Apply plans with account lease, write-ahead audit, and dependency gating

**Files:**

- Create: `src/app/services/apply-service.ts`
- Modify: `test/support/change-service-fixtures.ts`
- Create: `test/unit/services/apply-service.test.ts`

**Produces:**

```ts
export type ApplyInput = Readonly<{
  planId: PlanId;
  expectedHash: string;
  failureMode: FailureMode;
}>;

export type ApplyResult = Readonly<{
  run: ChangeRun;
  warnings: readonly string[];
  counts: Readonly<Record<RunOperationStatus, number>>;
  errors: readonly SerializedDomainError[]; // at most 20
  auditCursor: string | null;
}>;

export class ApplyService {
  apply(input: ApplyInput, signal?: AbortSignal): Promise<ApplyResult>;
}
```

- [ ] **Step 1: Write failing admission, lease, dependency, and result tests**

Use table tests to prove that read-only mode, malformed expected hash,
recomputed/stored hash mismatch, expected/stored mismatch, expiry, wrong
host/login/account ID, an explicitly unavailable required write capability,
superseded/failed plan state, and an already-aborted signal all reject before a
run or plan-state change and before a mutation. A write capability that remains
`unknown` after non-mutating probes is allowed with a prominent warning; the
first real permission rejection is classified and audited as
`INSUFFICIENT_PERMISSION`.

Also test:

- The account lease name is derived from host and a stable hash of account ID, not login alone.
- A second service/process cannot apply another plan for the same account while the first lease is held.
- Two concurrent `apply` calls through the same service instance receive
  different scope owner IDs; exactly one acquires the account lease and the
  other fails before a run/plan-state change or mutation.
- The shared `LeaseScope` heartbeat renews periodically well below TTL,
  remains held through `pacer.waitForSafetyWindow`, and uses fresh `now` for
  every guarded write. A mutation that takes longer than one TTL still cannot
  overlap a second owner.
- A GitHub callback observes its run operation already in `running`.
- The callback also observes a running attempt row with the same incremented
  attempt number; every repeated dispatch leaves the earlier attempt rows
  queryable.
- A completed apply called twice returns the same run and performs no second mutation.
- `stop` leaves later operations unscheduled and the run/plan partial.
- `continue` executes independent operations but records a dependent operation as `failed`, `error.retryable === true`, `details.reason === "dependency_blocked"`, and `reconciliation === "confirmed_not_applied"` without dispatch.
- A later successful prerequisite allows that dependent row to enter `retryRunOperation` and execute.
- Abort after write-ahead but before dispatch finishes that row as retryable/confirmed-not-applied and leaves the run partial.
- The result contains the same persisted run warnings, aggregate counts, at
  most 20 errors, and an audit cursor rather than every operation.

- [ ] **Step 2: Prove ApplyService is absent**

Run:

```bash
npm test -- test/unit/services/apply-service.test.ts
```

Expected: FAIL resolving `apply-service.ts`.

- [ ] **Step 3: Implement admission and serial orchestration**

Implement this exact order:

1. Reject read-only mode and an already-aborted signal.
2. Load the persisted plan. Recompute `hashPlanExecutable(plan.executable)`, require it equals `plan.hash`, require `input.expectedHash` equals `plan.hash`, and require 64 lowercase hex.
3. Call `getViewer` and require its exact host/login/stable account ID binding.
   If the plan is already `applied`, load and validate its unique completed
   run and return the original bounded result now—before capability probes,
   expiry admission, or account-lease acquisition. A later TTL expiry or
   another plan's active account lease cannot break this idempotent read.
4. For any non-applied plan, reject expiry and
   `expired|failed|superseded`/unknown states without local or remote
   mutation. Call `probeCapabilities` and reject
   only a required write capability that is `unavailable`. Accept `unknown`
   because a no-write probe cannot prove every fine-grained token permission;
   create one stable, redacted warning per unknown required capability, persist
   it in the new run, return `warnings === run.warnings`, and preserve it
   unchanged on resume. Then let the fixed mutation endpoint
   return an audited `INSUFFICIENT_PERMISSION` without retry.
5. Derive a new unpredictable owner ID
   `${instanceId}:${runtime.requestId()}` for this call, acquire
   `apply:<host>:<sha256(accountId)[0..15]>`, and start `LeaseScope`. Never use
   the process-level `instanceId` alone as the lease owner. Storage rejects
   every active reacquire including a same-owner value; only `renewLease` may
   extend the scope. Failure is retryable `CAPABILITY_UNAVAILABLE`.
6. Under that lease, call targeted
   `recoverAbandonedRuns({binding,lease:freshGuard})`
   before admission. This immediately converts an expired prior owner's
   pending/running run to partial even when the server has not restarted; it
   skips all exact-owner active work.
7. In one synchronous transaction, assert the exact active lease,
   re-read/revalidate the plan, return its one existing completed run
   unchanged, or atomically claim `ready|partial -> applying`, create the
   plan's only run, or rebind its existing partial run to this lease and move
   it back to running. A resume must preserve its original `failureMode`;
   reject a conflicting mode.
8. Rebuild `createdListIdsByOperationId` from every succeeded `list_create` run row's persisted `after.listId`.
9. Iterate `topologicalOperationIds`. Skip succeeded or semantically
   idempotent skipped rows. If no audit row exists, first call lease-guarded
   `createRunOperation` with `pending`/attempt zero. Reconcile every existing
   unresolved row before any scheduling; a confirmed success is now terminal,
   confirmed-not-applied becomes failed, and unknown remains unschedulable.
10. Require every dependency row to be succeeded or skipped. For a new pending
    row whose dependency is blocked, finish it as retryable
    confirmed-not-applied with no attempt. Leave an already-failed retry row
    failed while its dependency is blocked.
11. When dependencies are ready, call `retryRunOperation` only for an existing
    `failed/confirmed_not_applied` row with a retryable error and attempts below
    `maxAttempts`; that queues it as pending without deleting attempts/events.
    Never recreate a row and never pass unresolved directly to retry.
12. Pass `signal` through `pacer.run`. Its `prepare` callback performs all
    asynchronous identity/precondition reads. Already-desired state finishes
    the pending row as skipped with no attempt; stale/precondition failure
    finishes it as confirmed-not-applied with no attempt.
13. Only for a prepared mutation, the pacer's `dispatch` callback obtains a
    fresh heartbeat guard, calls `startRunOperation` (the sole attempt
    increment and attempt-row append), then immediately calls
    non-async `executor.dispatchPrepared(...)` without another await. The fake
    transport must record dispatch before the callback returns its Promise.
14. Finish each row through the discriminated lease-guarded method with
    sanitized after state, request ID, reconciliation, and serialized error.
    Storage—not the caller—preserves before/attempts and atomically finalizes
    the current attempt. Successful rows are never modified again.
15. Derive run and plan terminal/partial state from persisted rows in one
    synchronous transaction that first asserts the lease.
16. Return bounded counts/errors and an inspection cursor.
17. In cleanup, keep the heartbeat alive through non-cancellable
    `pacer.waitForSafetyWindow()`, stop it, then release only if still owner.
    Preserve/rethrow the primary apply error; cleanup owner/not-found errors
    are diagnostic and never mask it. With no primary error, cleanup failure is
    surfaced. No SQLite transaction spans either await.

Use `startRunOperation` as the sole attempt-increment CAS and audit-attempt
append. Unscheduled operations have no row; pre-dispatch skipped/failed rows
have no attempt; a partial result is still derived by comparing rows with plan
operations.

If heartbeat loss occurs before dispatch, stop without calling
`startRunOperation`. If it occurs while one GitHub request is in flight, issue
no further dispatch. Use a fresh guard to persist the response only if this
process is still owner; otherwise leave the running attempt untouched for
lease-aware startup recovery to mark unresolved and later reconcile.

- [ ] **Step 4: Verify admission and orchestration**

Run:

```bash
npm test -- test/unit/services/apply-service.test.ts test/unit/services/mutation-pacer.test.ts test/unit/services/mutation-executor.test.ts
npm run typecheck
npm run lint
```

Expected: all rejection paths leave zero runs; write-ahead, lease lifetime, dependency gating, bounded results, and repeated apply pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/apply-service.ts test/support/change-service-fixtures.ts test/unit/services/apply-service.test.ts
git commit -m "feat: apply plans with durable audit"
```

### Task 5: Reconcile every ambiguous mutation and resume the same run

**Files:**

- Create: `src/app/services/reconciliation.ts`
- Modify: `src/app/services/apply-service.ts`
- Modify: `src/app/services/mutation-executor.ts`
- Modify: `test/support/change-service-fixtures.ts`
- Create: `test/unit/services/apply-reconciliation.test.ts`

**Produces:**

```ts
export type ReconciliationDecision =
  | Readonly<{ kind: "confirmed_applied"; state: JsonValue }>
  | Readonly<{ kind: "confirmed_not_applied"; state: JsonValue }>
  | Readonly<{ kind: "unknown"; state: JsonValue }>;

export function reconcileOperation(
  executor: MutationExecutor,
  operation: ResolvedOperation,
  context: ExecutionContext,
  signal?: AbortSignal,
): Promise<ReconciliationDecision>;
```

- [ ] **Step 1: Write a failing exhaustive reconciliation matrix**

Use `it.each` for this matrix:

| Operation | Confirmed applied | Confirmed not applied | Unknown |
|---|---|---|---|
| `star` | stable repository exists and is starred | stable repository exists and is unstarred | identity mismatch/missing |
| `unstar` | stable repository exists and is unstarred | stable repository exists and is starred | identity mismatch/missing |
| `list_update` | same List ID has exact after metadata | same List ID has exact before metadata | missing or third metadata state |
| `list_delete` | List ID is absent | same List ID has exact before metadata | same ID has changed metadata |
| `list_membership_set` | complete sorted IDs equal target | complete sorted IDs equal expected | any third set |
| `list_create` | exactly one new List ID absent from `before.listIds` matches exact desired metadata | zero new matching IDs | two or more new matching IDs |

For confirmed `list_create`, assert the new ID is stored in `createdListIdsByOperationId`. Existing same-name Lists present in `before.listIds` never count as newly created.

Add resume tests proving:

- Reset after dispatch results in one transport dispatch.
- Desired readback persists `succeeded` and `confirmed_applied`.
- Before-state readback persists `failed`, a retryable serialized error, and `confirmed_not_applied`.
- Third-state readback persists `unresolved` and `unknown`.
- Startup recovery never exposes a recovered `running` row: expired-owner
  running projections/attempts become unresolved, while another active
  process's rows are skipped. Resume reconciles every unresolved row before
  considering any retryable failed row.
- Resume calls `retryRunOperation` to queue, then `startRunOperation` to
  increment attempts immediately before dispatch; it preserves success and
  reuses the run ID.
- A configured attempt ceiling is enforced. Only a proved-before state may retry.
- Runtime created-List mappings are restored from succeeded audit rows after process restart.
- Rate/secondary-limit retry timing is honored only after confirmed-not-applied; it never causes transport-level replay.

- [ ] **Step 2: Prove the matrix is unsupported**

Run:

```bash
npm test -- test/unit/services/apply-reconciliation.test.ts
```

Expected: FAIL resolving `reconciliation.ts` or on incorrect resume state.

- [ ] **Step 3: Implement reconciliation and recovery**

`reconcileOperation` performs only named live reads. It never mutates. Persist decisions as:

- `confirmed_applied` -> `status: "succeeded"`, `reconciliation: "confirmed_applied"`.
- `confirmed_not_applied` -> `status: "failed"`, serialized `RECONCILIATION_REQUIRED` with `retryable: true`, `reconciliation: "confirmed_not_applied"`.
- `unknown` -> `status: "unresolved"`, serialized `RECONCILIATION_REQUIRED` with `retryable: false`, `reconciliation: "unknown"`.

All three transitions use the lease-guarded
`StoragePort.reconcileRunOperation`, the dedicated CAS from an existing
unresolved projection. It preserves the dispatch attempt's original ambiguous
outcome/time, appends an immutable reconciliation event, and atomically updates
only the projection. Repeated unknown readbacks therefore remain independently
auditable. They never route through `finishRunOperation`, which is reserved
for pending/running current-attempt records.

On apply/resume:

1. Reconcile unresolved rows before deciding whether they can run; a running
   row with another live owner is not resumable.
2. Never retry `unknown`.
3. Retry only `failed + confirmed_not_applied + error.retryable`, only while
   `attempts < maxAttempts`, and only via `retryRunOperation`.
4. Recheck dependencies immediately before retry.
5. Honor persisted rate-limit time and cancellation before the retry write-ahead transition.
6. Rebuild create-operation mappings before reconciling dependent membership.

Keep the mutation transport's retry count at zero; all repeat dispatches and
all reconciliation observations are visible as separate rows through bounded
inspection.

- [ ] **Step 4: Verify reconciliation and full apply**

Run:

```bash
npm test -- test/unit/services/apply-reconciliation.test.ts test/unit/services/apply-service.test.ts test/contract/github/mutations.test.ts
npm run typecheck
npm run lint
```

Expected: every matrix row passes, reset dispatch count is one, and resume uses one run ID.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/reconciliation.ts src/app/services/apply-service.ts src/app/services/mutation-executor.ts test/support/change-service-fixtures.ts test/unit/services/apply-reconciliation.test.ts
git commit -m "feat: reconcile and resume partial runs"
```

### Task 6: Project successful work into dependency-safe rollback plans

**Files:**

- Create: `src/app/services/rollback-service.ts`
- Modify: `test/support/change-service-fixtures.ts`
- Create: `test/unit/services/rollback-service.test.ts`

**Produces:**

```ts
export type CreateRollbackInput = Readonly<{
  runId: RunId;
  protectedRepositoryIds: readonly RepositoryId[];
  protectedListIds: readonly UserListId[];
  ttlMinutes?: number;
  callerNote?: string;
}>;

export class RollbackService {
  createRollback(input: CreateRollbackInput): Promise<CreatePlanResult>;
}
```

- [ ] **Step 1: Write failing source-state, projection, and protection tests**

Test:

- Only source runs in `completed|partial` are accepted.
- No GitHub read or mutation method is called while creating a rollback plan.
- Only source `RunOperation.status === "succeeded"` participates.
- The successful-operation induced subgraph is reversed before projection.
- `star -> unstar`.
- `unstar -> star` plus membership restoration from the source operation's persisted before/inverse state, because live unstar may have removed List membership.
- `list_create -> list_delete` using the actual List ID from the successful run row's `after`.
- `list_update -> list_update` with exact before metadata.
- `list_delete -> list_create` plus one membership restoration per former member, coalesced with other restoration for the same repository.
- `list_membership_set -> list_membership_set` with exact before IDs.
- Recreated Lists are logical created targets and every restoration depends on the recreation.
- Re-star occurs before its membership restoration.
- Membership removal required before deleting a List occurs first.
- A protected inverse prerequisite causes its dependent inverse operations to be omitted with warnings; no dangling dependency remains.
- Warnings include lost `starred_at`, new List IDs, protected skips, and any partial source coverage.
- Repeating rollback creation against the same run yields identical executable/hash and deterministic operation IDs.

- [ ] **Step 2: Prove RollbackService is absent**

Run:

```bash
npm test -- test/unit/services/rollback-service.test.ts
```

Expected: FAIL resolving `rollback-service.ts`.

- [ ] **Step 3: Implement induced-graph reversal and one-to-many projection**

Use this algorithm:

1. Load source run and plan; reject any source state outside `completed|partial`.
2. Require the source run binding to equal the source plan executable binding; live identity is intentionally deferred to apply.
3. Select successful run rows and the corresponding original operations.
4. Build their induced dependency graph, then process `reverseDependencyOperationIds`.
5. Project each operation using the explicit rules above. The first inverse ID is `undo_<source-operation-id>`; additional deterministic projections use `undo_<source-operation-id>_<kind>_<six-digit-sequence>`.
6. Track each projection's entry and exit nodes. For original edge `B depends on A`, make every entry node of inverse(A) depend on every exit node of inverse(B). Add internal projection edges.
7. Coalesce exact membership restorations by repository only when their desired complete sets agree; otherwise reject with `PRECONDITION_FAILED`.
8. Apply protected-target closure: remove a protected inverse and every inverse transitively requiring it, record warnings, then rebuild dependencies without dangling IDs.
9. Validate the new graph, construct normal `PlanExecutableContent` using the source plan's snapshot ID and run binding, hash it, and save once.

Rollback operation routing/preconditions come from persisted source `before`/`after`, not a new snapshot. Rollback creation has no `GitHubPort` dependency and performs no network call.

- [ ] **Step 4: Verify rollback and graph safety**

Run:

```bash
npm test -- test/unit/services/rollback-service.test.ts test/unit/domain/plan-run.test.ts
npm run typecheck
npm run lint
```

Expected: one-to-many inversion, reversed dependencies, protection closure, deterministic hash, and zero GitHub mutations pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/rollback-service.ts test/support/change-service-fixtures.ts test/unit/services/rollback-service.test.ts
git commit -m "feat: generate safe rollback plans"
```

### Task 7: Add bounded audit inspection and executable capability proof

**Files:**

- Create: `src/app/services/inspect-service.ts`
- Modify: `test/support/change-service-fixtures.ts`
- Create: `test/unit/services/inspect-service.test.ts`
- Create: `test/security/github-capability-boundary.test.ts`

**Produces:**

```ts
export type InspectInput =
  | Readonly<{kind:"plan"|"run";id:string;limit?:number;cursor?:string|null}>
  | Readonly<{kind:"attempts"|"reconciliations";id:RunId;operationId:string;limit?:number;cursor?:string|null}>;

export class InspectService {
  inspect(input: InspectInput): Promise<InspectResult>;
}
```

- [ ] **Step 1: Write failing cursor, redaction, and boundary tests**

Test:

- Default limit 50, allowed range 1–100, stable sequence ordering, no duplicates across pages.
- Plan/run cursor payload is
  `{version:1,kind,targetId,afterSequence}`. Attempt cursor payload is
  `{version:1,kind:"attempts",runId,operationId,afterAttempt}`.
- Reconciliation cursor payload is
  `{version:1,kind:"reconciliations",runId,operationId,afterEventSequence}`.
- A run cursor reused for a plan, a cursor reused for a different ID, invalid base64/JSON/version, negative sequence, and sequence beyond target all fail `VALIDATION_ERROR`.
- Nested error headers, URLs, descriptions, and details are recursively redacted.
- Plan inspection pages its persisted `operations`; run inspection calls
  `listRunOperationsPage`; attempt inspection calls
  `listRunOperationAttemptsPage`; reconciliation inspection calls
  `listRunOperationReconciliationsPage`. Each response includes total and
  never flattens either history into the run page.
- Empty final page has `nextCursor: null`.

Do not reflect a TypeScript interface at runtime. Instead test the frozen executable manifest:

```ts
expect(GITHUB_MUTATION_METHOD_NAMES).toEqual([
  "star",
  "unstar",
  "createUserList",
  "updateUserList",
  "deleteUserList",
  "setRepositoryListIds",
]);
expect(Object.isFrozen(GITHUB_MUTATION_METHOD_NAMES)).toBe(true);
```

The security test also reads `src/app/ports/github-port.ts` and `src/github/octokit-github-adapter.ts` as source text and rejects `deleteRepository`, `archiveRepository`, `transferRepository`, `updateRepository`, `updateFile`, `createOrUpdateFile`, `rawRequest`, and any public generic `request(` or `graphql(` member. The compile-time `satisfies readonly (keyof GitHubPort)[]` check keeps the manifest aligned with the port.

- [ ] **Step 2: Prove inspect and boundary proof are absent**

Run:

```bash
npm test -- test/unit/services/inspect-service.test.ts test/security/github-capability-boundary.test.ts
```

Expected: FAIL resolving `inspect-service.ts` or the mutation manifest.

- [ ] **Step 3: Implement target-bound cursor paging**

Encode cursor JSON as base64url. Decode and validate every field before storage
access. For run/attempt/reconciliation pages, convert only the validated
boundary to the matching Plan 01 storage call and bind its returned next
boundary into a new cursor with the exact kind and target tuple. For plan
pages, treat operation order as zero-based sequence consistently with
persisted plan operations and slice deterministically.

Call `redactSecrets` on the complete presentation object after paging. Never return raw storage errors, auth headers, tokens, the full unbounded run-operation array, or a cursor containing account data.

- [ ] **Step 4: Verify inspection and boundary**

Run:

```bash
npm test -- test/unit/services/inspect-service.test.ts test/security/github-capability-boundary.test.ts
npm run typecheck
npm run lint
```

Expected: cursor binding, paging, redaction, frozen manifest, and forbidden source checks pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/inspect-service.ts test/support/change-service-fixtures.ts test/unit/services/inspect-service.test.ts test/security/github-capability-boundary.test.ts
git commit -m "feat: add bounded audit inspection"
```

### Task 8: Add an opt-in disposable-account live contract

**Files:**

- Modify: `vitest.config.ts`
- Modify: `package.json`
- Create: `vitest.live.config.ts`
- Create: `test/fixtures/live-contract.ts`
- Create: `test/unit/live-contract-config.test.ts`
- Create: `test/live/disposable-account.contract.test.ts`

- [ ] **Step 1: Write the deterministic guard tests**

`test/unit/live-contract-config.test.ts` must prove that each missing guard rejects:

- `GITHUB_STARS_MCP_LIVE=1`
- `GITHUB_STARS_MCP_LIVE_CONFIRM=DELETE_TEST_DATA`
- `GITHUB_STARS_MCP_LIVE_LOGIN`
- `GITHUB_STARS_MCP_LIVE_REPOSITORY`

Require the repository to equal `<login>/github-stars-mcp-fixture-<suffix>` with a non-empty suffix. Reject any other owner or prefix.

- [ ] **Step 2: Prove only the unit guard is missing**

Run:

```bash
npm test -- test/unit/live-contract-config.test.ts
```

Expected: FAIL resolving `test/fixtures/live-contract.ts`. This command must not discover or run `test/live/**`.

- [ ] **Step 3: Implement separate default and live suites**

In default `vitest.config.ts`, exclude `test/live/**`. Create `vitest.live.config.ts` whose include is only `test/live/**/*.contract.test.ts`. Add:

```json
{
  "scripts": {
    "test:live": "vitest run --config vitest.live.config.ts"
  }
}
```

`loadLiveContractConfig` validates all four guards and returns `{ login, repository, reportPath }`, with report path `artifacts/live-contract.json`.

The live test must:

1. Be wrapped in `describe.skipIf(process.env.GITHUB_STARS_MCP_LIVE !== "1")`.
2. Verify `getViewer().login` exactly before mutation.
3. Capture original Star state and complete membership state.
4. Create a uniquely named private List and use only the named fixture repository.
5. Observe and report whether List deletion changes Star state and whether unstar changes membership state.
6. Sanitize the report.
7. Put restoration in `finally`: restore original Star state, restore original membership where possible, and delete every List created by the test.
8. Record each cleanup action and result in the report even when the main assertion fails.
9. Write the report before rethrowing the primary error or an `AggregateError` containing cleanup failures.

No PR/default CI command may execute the live suite.

- [ ] **Step 4: Verify isolation and compilation**

Run:

```bash
npm test -- test/unit/live-contract-config.test.ts
npm test -- test/security/github-capability-boundary.test.ts
npm run typecheck
npm run lint
```

Expected: deterministic tests pass, live code type-checks, and default Vitest discovers no live test.

Optional manual disposable-account verification:

```bash
GITHUB_STARS_MCP_LIVE=1 GITHUB_STARS_MCP_LIVE_CONFIRM=DELETE_TEST_DATA GITHUB_STARS_MCP_LIVE_LOGIN=<disposable-login> GITHUB_STARS_MCP_LIVE_REPOSITORY=<disposable-login>/github-stars-mcp-fixture-<suffix> npm run test:live
```

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts vitest.live.config.ts package.json test/fixtures/live-contract.ts test/unit/live-contract-config.test.ts test/live/disposable-account.contract.test.ts
git commit -m "test: add guarded GitHub live contract"
```

## Plan Acceptance

- Every selector is exhausted against one complete snapshot; protected IDs cannot enter destructive operations.
- Plans derive account binding from the snapshot, use deterministic operation IDs, enforce expiry/size limits, validate dependencies, and hash only executable content.
- The GitHub port exposes only named Star/List reads and six fixed mutations; mutation transport performs exactly one dispatch per audited attempt.
- Star writes verify live node and database IDs; membership writes compare complete fully paginated sets.
- Apply recomputes the persisted hash, verifies exact viewer/capabilities, holds a global account lease through the pacing window, and writes audit intent before dispatch.
- Abort, stop/continue, dependency blocking, superseded state, partial resume, retry CAS, and bounded output have focused tests.
- Every mutation kind has an explicit ambiguity matrix. `list_create` distinguishes zero, one, and multiple new matching IDs.
- Resume reuses one run, restores runtime List-ID mappings, preserves successes, and retries only proved-before state within the attempt budget.
- Rollback accepts only completed/partial source runs, reverses the successful induced graph, supports one-to-many inverse projection, closes over protected prerequisites, and performs no GitHub mutation.
- Inspection cursors bind kind, target ID, and sequence; all results are bounded and recursively redacted.
- The capability test uses a frozen runtime manifest plus source-boundary checks, never fictional interface reflection.
- The live suite is excluded by default, requires all disposable-account guards, and reports `finally` cleanup results.
