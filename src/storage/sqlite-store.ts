import { isAbsolute } from "node:path";
import type Database from "better-sqlite3";
import type {
  StoragePort,
  StorageTransaction,
} from "../app/ports/storage-port.js";
import { SystemRuntime, type Clock } from "../app/ports/runtime-port.js";
import {
  canonicalJsonClone,
  freezeJsonValue,
} from "../domain/canonical-json.js";
import { createCursorCodec } from "../domain/cursor.js";
import { AppError } from "../domain/errors.js";
import type { JsonValue } from "../domain/json.js";
import { canonicalUtcTimestamp } from "../domain/timestamp.js";
import { LeaseRepository } from "./lease-repository.js";
import {
  migrationChecksum,
  migrateSqliteDatabase,
  openSqliteDatabase,
  SQLITE_MIGRATIONS,
} from "./sqlite-database.js";
import { PlanRunRepository } from "./plan-run-repository.js";
import { RuntimeSecretRepository } from "./runtime-secret-repository.js";
import { SnapshotRepository } from "./snapshot-repository.js";
import {
  prepareStateDirectory,
  validateStateFilesAfterOpen,
} from "./state-directory.js";
import { runInNewImmediateTransaction } from "./sqlite-transaction.js";

type Lifecycle = "new" | "migrating" | "ready" | "closed";
type TransactionMethodName = keyof StorageTransaction;

const TRANSACTION_METHODS = Object.freeze([
  "assertLease",
  "createSnapshot",
  "appendSnapshotBatch",
  "beginSnapshotVerification",
  "appendSnapshotVerificationBatch",
  "finishSnapshotVerification",
  "completeSnapshot",
  "failSnapshot",
  "getCompleteSnapshot",
  "getLatestCompleteSnapshot",
  "getRepositoryMetadata",
  "getSnapshotRepository",
  "getSnapshotListSummary",
  "queryRepositories",
  "queryLists",
  "queryListMemberships",
  "hasStar",
  "savePlan",
  "getPlan",
  "compareAndSetPlanState",
  "createRun",
  "getRun",
  "getLatestRunForPlan",
  "compareAndSetRunState",
  "createRunOperation",
  "startRunOperation",
  "getRunOperation",
  "retryRunOperation",
  "listRunOperations",
  "listRunOperationsPage",
  "finishRunOperation",
  "reconcileRunOperation",
  "getRunOperationAttempt",
  "listRunOperationAttemptsPage",
  "listRunOperationReconciliationsPage",
  "recoverAbandonedRuns",
  "acquireLease",
  "renewLease",
  "releaseLease",
] satisfies readonly TransactionMethodName[]);

const uint8ArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const uint8ArrayFillAtLoad = (
  Object.getOwnPropertyDescriptor(uint8ArrayPrototype, "fill") as {
    readonly value: (this: Uint8Array, value: number) => Uint8Array;
  }
).value;
const uint8ArraySetAtLoad = (
  Object.getOwnPropertyDescriptor(uint8ArrayPrototype, "set") as {
    readonly value: (
      this: Uint8Array,
      source: ArrayLike<number>,
      offset?: number,
    ) => void;
  }
).value;
const uint8ArrayByteLengthAtLoad = (
  Object.getOwnPropertyDescriptor(uint8ArrayPrototype, "byteLength") as {
    readonly get: (this: Uint8Array) => number;
  }
).get;
const freezeAtLoad = Object.freeze;
const STORE_INTRINSICS = freezeAtLoad({
  objectCreate: Object.create,
  objectDefineProperty: Object.defineProperty,
  objectFreeze: freezeAtLoad,
  proxyRevocable: Proxy.revocable,
  reflectApply: Reflect.apply,
  uint8ArrayConstructor: Uint8Array,
  uint8ArrayByteLength: uint8ArrayByteLengthAtLoad,
  uint8ArrayFill: uint8ArrayFillAtLoad,
  uint8ArraySet: uint8ArraySetAtLoad,
});
interface MigrationLedgerRow {
  readonly version: unknown;
  readonly name: unknown;
  readonly checksum: unknown;
}

interface FacadeToken {
  active: boolean;
}

interface RevocableFacade {
  readonly facade: StorageTransaction;
  readonly token: FacadeToken;
  readonly revoke: () => void;
}

function storageError(message: string): AppError {
  return new AppError("STORAGE_ERROR", message);
}

function safeAppError(error: AppError): AppError {
  let details: JsonValue = {};
  try {
    details = canonicalJsonClone(error.details);
  } catch {
    // Unsafe diagnostics are discarded at the storage boundary.
  }
  return new AppError(error.code, error.message, {
    retryable: error.retryable,
    details,
  });
}

function precondition(message: string): AppError {
  return new AppError("PRECONDITION_FAILED", message);
}

function wipeBytes(value: Uint8Array | undefined): void {
  if (value === undefined) return;
  try {
    STORE_INTRINSICS.reflectApply(STORE_INTRINSICS.uint8ArrayFill, value, [0]);
  } catch {
    // Wiping is best-effort and must never replace the primary failure.
  }
}

function transactionReturnError(): AppError {
  return precondition(
    "transaction return value must be bounded canonical synchronous data",
  );
}

/**
 * Synchronous SQLite-backed StoragePort.
 *
 * Construction validates only the path shape. Filesystem and database work is
 * deliberately deferred until migrate().
 */
export class SQLiteStore implements StoragePort {
  readonly #dataDirectoryOrMemory: string;
  readonly #clock: Pick<Clock, "now">;
  #lifecycle: Lifecycle = "new";
  #database: Database.Database | undefined;
  #delegate: StorageTransaction | undefined;
  #snapshotRepository: SnapshotRepository | undefined;
  #planRunRepository: PlanRunRepository | undefined;
  #transactionActive = false;
  #transactionPoisoned = false;

  constructor(
    dataDirectoryOrMemory: string,
    clock: Pick<Clock, "now"> = new SystemRuntime(),
  ) {
    if (
      typeof dataDirectoryOrMemory !== "string" ||
      dataDirectoryOrMemory.length === 0 ||
      dataDirectoryOrMemory.includes("\0") ||
      (dataDirectoryOrMemory !== ":memory:" &&
        !isAbsolute(dataDirectoryOrMemory))
    ) {
      throw storageError(
        "SQLite storage requires :memory: or an absolute data directory",
      );
    }
    this.#dataDirectoryOrMemory = dataDirectoryOrMemory;
    this.#clock = clock;
  }

  #guardRootCall(): void {
    if (this.#transactionActive) {
      this.#transactionPoisoned = true;
      throw precondition("root storage reentry invalidated the transaction");
    }
  }

  #readyDelegate(): StorageTransaction {
    if (
      this.#lifecycle !== "ready" ||
      this.#database === undefined ||
      this.#delegate === undefined
    ) {
      throw storageError("SQLite storage is not ready");
    }
    return this.#delegate;
  }

  #readyDatabase(): Database.Database {
    if (
      this.#lifecycle !== "ready" ||
      this.#database === undefined ||
      this.#delegate === undefined
    ) {
      throw storageError("SQLite storage is not ready");
    }
    return this.#database;
  }

  #repositoryOperation<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof AppError) throw safeAppError(error);
      throw storageError("SQLite storage operation failed");
    }
  }

  #invoke(
    delegate: StorageTransaction,
    method: TransactionMethodName,
    args: readonly unknown[],
  ): unknown {
    const methods = delegate as unknown as Readonly<
      Record<string, (...input: unknown[]) => unknown>
    >;
    const operation = methods[method];
    if (operation === undefined) {
      throw storageError("SQLite storage delegate is incomplete");
    }
    return this.#repositoryOperation(() =>
      STORE_INTRINSICS.reflectApply(operation, delegate, args),
    );
  }

  #rootInvoke(
    method: TransactionMethodName,
    args: readonly unknown[],
  ): unknown {
    this.#guardRootCall();
    return this.#invoke(this.#readyDelegate(), method, args);
  }

  #createDelegate(
    leases: LeaseRepository,
    snapshots: SnapshotRepository,
    plans: PlanRunRepository,
  ): StorageTransaction {
    return STORE_INTRINSICS.objectFreeze({
      assertLease: (input) => leases.assertLease(input),
      createSnapshot: (input) => snapshots.createSnapshot(input),
      appendSnapshotBatch: (input) => snapshots.appendSnapshotBatch(input),
      beginSnapshotVerification: (input) =>
        snapshots.beginSnapshotVerification(input),
      appendSnapshotVerificationBatch: (input) =>
        snapshots.appendSnapshotVerificationBatch(input),
      finishSnapshotVerification: (input) =>
        snapshots.finishSnapshotVerification(input),
      completeSnapshot: (input) => snapshots.completeSnapshot(input),
      failSnapshot: (input) => snapshots.failSnapshot(input),
      getCompleteSnapshot: (id) => snapshots.getCompleteSnapshot(id),
      getLatestCompleteSnapshot: (binding) =>
        snapshots.getLatestCompleteSnapshot(binding),
      getRepositoryMetadata: (id) => snapshots.getRepositoryMetadata(id),
      getSnapshotRepository: (snapshotId, repositoryId) =>
        snapshots.getSnapshotRepository(snapshotId, repositoryId),
      getSnapshotListSummary: (snapshotId, listId) =>
        snapshots.getSnapshotListSummary(snapshotId, listId),
      queryRepositories: (input) => snapshots.queryRepositories(input),
      queryLists: (input) => snapshots.queryLists(input),
      queryListMemberships: (input) => snapshots.queryListMemberships(input),
      hasStar: (snapshotId, repositoryId) =>
        snapshots.hasStar(snapshotId, repositoryId),
      savePlan: (plan) => plans.savePlan(plan),
      getPlan: (id) => plans.getPlan(id),
      compareAndSetPlanState: (input) => plans.compareAndSetPlanState(input),
      createRun: (input) => plans.createRun(input),
      getRun: (id) => plans.getRun(id),
      getLatestRunForPlan: (planId) => plans.getLatestRunForPlan(planId),
      compareAndSetRunState: (input) => plans.compareAndSetRunState(input),
      createRunOperation: (input) => plans.createRunOperation(input),
      startRunOperation: (input) => plans.startRunOperation(input),
      getRunOperation: (input) => plans.getRunOperation(input),
      retryRunOperation: (input) => plans.retryRunOperation(input),
      listRunOperations: (runId) => plans.listRunOperations(runId),
      listRunOperationsPage: (input) => plans.listRunOperationsPage(input),
      finishRunOperation: (input) => plans.finishRunOperation(input),
      reconcileRunOperation: (input) => plans.reconcileRunOperation(input),
      getRunOperationAttempt: (input) => plans.getRunOperationAttempt(input),
      listRunOperationAttemptsPage: (input) =>
        plans.listRunOperationAttemptsPage(input),
      listRunOperationReconciliationsPage: (input) =>
        plans.listRunOperationReconciliationsPage(input),
      recoverAbandonedRuns: (input) => plans.recoverAbandonedRuns(input),
      acquireLease: (input) => leases.acquireLease(input),
      renewLease: (input) => leases.renewLease(input),
      releaseLease: (input) => leases.releaseLease(input),
    } satisfies StorageTransaction);
  }

  #createTransactionFacade(delegate: StorageTransaction): RevocableFacade {
    const token: FacadeToken = { active: true };
    const target = STORE_INTRINSICS.objectCreate(null) as Record<
      string,
      unknown
    >;
    for (let index = 0; index < TRANSACTION_METHODS.length; index += 1) {
      const method = TRANSACTION_METHODS[index]!;
      const descriptor = STORE_INTRINSICS.objectCreate(
        null,
      ) as PropertyDescriptor;
      descriptor.configurable = false;
      descriptor.enumerable = true;
      descriptor.value = (...args: unknown[]): unknown => {
        if (!token.active) {
          throw precondition("transaction facade is revoked");
        }
        return this.#invoke(delegate, method, args);
      };
      descriptor.writable = false;
      STORE_INTRINSICS.objectDefineProperty(target, method, descriptor);
    }
    STORE_INTRINSICS.objectFreeze(target);
    const handler = STORE_INTRINSICS.objectCreate(null) as object;
    STORE_INTRINSICS.objectFreeze(handler);
    const revocable = STORE_INTRINSICS.proxyRevocable(target, handler);
    return {
      facade: revocable.proxy as unknown as StorageTransaction,
      token,
      revoke: revocable.revoke,
    };
  }

  #clearRepositories(): void {
    this.#delegate = undefined;
    this.#snapshotRepository = undefined;
    this.#planRunRepository = undefined;
  }

  migrate(): void {
    this.#guardRootCall();
    if (this.#lifecycle === "ready") return;
    if (this.#lifecycle === "closed") {
      throw storageError("closed SQLite storage cannot be migrated");
    }
    if (this.#lifecycle === "migrating") {
      throw precondition("SQLite storage migration is already active");
    }

    this.#lifecycle = "migrating";
    let database: Database.Database | undefined;
    try {
      if (typeof this.#clock !== "object" || this.#clock === null) {
        throw storageError("SQLite storage clock is invalid");
      }
      const nowMethod = this.#clock.now;
      if (typeof nowMethod !== "function") {
        throw storageError("SQLite storage clock is invalid");
      }
      const migrationTime = canonicalUtcTimestamp(
        STORE_INTRINSICS.reflectApply(nowMethod, this.#clock, []),
        "migration time",
      );
      const prepared =
        this.#dataDirectoryOrMemory === ":memory:"
          ? undefined
          : prepareStateDirectory(this.#dataDirectoryOrMemory);
      database = openSqliteDatabase(
        prepared === undefined ? ":memory:" : prepared.databasePath,
      );
      migrateSqliteDatabase(database, migrationTime);
      if (prepared !== undefined) {
        validateStateFilesAfterOpen(prepared);
      }

      let selectedKey: Uint8Array | undefined;
      let codecKey: Uint8Array | undefined;
      let codec: ReturnType<typeof createCursorCodec>;
      try {
        selectedKey = new RuntimeSecretRepository(
          database,
        ).getOrCreateCursorSigningKey(migrationTime);
        const selectedKeyLength = STORE_INTRINSICS.reflectApply(
          STORE_INTRINSICS.uint8ArrayByteLength,
          selectedKey,
          [],
        );
        if (selectedKeyLength !== 32) {
          throw storageError("cursor signing key has an invalid length");
        }
        codecKey = new STORE_INTRINSICS.uint8ArrayConstructor(32);
        STORE_INTRINSICS.reflectApply(
          STORE_INTRINSICS.uint8ArraySet,
          codecKey,
          [selectedKey],
        );
        if (
          STORE_INTRINSICS.reflectApply(
            STORE_INTRINSICS.uint8ArrayByteLength,
            codecKey,
            [],
          ) !== 32
        ) {
          throw storageError("cursor signing key copy failed");
        }
        codec = createCursorCodec(codecKey);
      } finally {
        wipeBytes(codecKey);
        wipeBytes(selectedKey);
      }
      const leases = new LeaseRepository(database);
      const snapshots = new SnapshotRepository(database, codec);
      const plans = new PlanRunRepository(database);
      const delegate = this.#createDelegate(leases, snapshots, plans);

      this.#database = database;
      this.#snapshotRepository = snapshots;
      this.#planRunRepository = plans;
      this.#delegate = delegate;
      this.#lifecycle = "ready";
      database = undefined;
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Preserve the primary migration failure.
      }
      this.#database = undefined;
      this.#clearRepositories();
      this.#lifecycle = "new";
      if (error instanceof AppError) throw safeAppError(error);
      throw storageError("SQLite storage migration failed");
    }
  }

  getSchemaVersion(): number {
    this.#guardRootCall();
    const database = this.#readyDatabase();
    return this.#repositoryOperation(() => {
      const rows = database
        .prepare(
          `SELECT version,name,checksum
           FROM schema_migrations
           ORDER BY version`,
        )
        .all() as MigrationLedgerRow[];
      if (rows.length !== SQLITE_MIGRATIONS.length) {
        throw storageError("SQLite schema migration ledger is not current");
      }
      for (let index = 0; index < SQLITE_MIGRATIONS.length; index += 1) {
        const migration = SQLITE_MIGRATIONS[index]!;
        const row = rows[index];
        if (
          row === undefined ||
          row.version !== migration.version ||
          row.version !== index + 1 ||
          row.name !== migration.name ||
          row.checksum !== migrationChecksum(migration)
        ) {
          throw storageError("SQLite schema migration ledger is invalid");
        }
      }
      // This is the public storage contract version, not the number of
      // internal forward-only SQLite migrations.
      return 1;
    });
  }

  withTransaction<T>(fn: (tx: StorageTransaction) => T): T {
    this.#guardRootCall();
    const database = this.#readyDatabase();
    const delegate = this.#readyDelegate();
    if (typeof fn !== "function") {
      throw new AppError(
        "VALIDATION_ERROR",
        "transaction callback must be synchronous",
      );
    }

    this.#transactionActive = true;
    this.#transactionPoisoned = false;
    let revocable: RevocableFacade | undefined;
    let preparedResult: JsonValue | undefined;
    let callbackThrew = false;
    let callbackError: unknown;
    try {
      const activeFacade = this.#createTransactionFacade(delegate);
      revocable = activeFacade;
      try {
        runInNewImmediateTransaction(database, () => {
          let rawResult: unknown;
          try {
            rawResult = fn(activeFacade.facade);
          } catch (error) {
            callbackThrew = true;
            callbackError = error;
            throw error;
          }

          if (rawResult === undefined) {
            preparedResult = undefined;
          } else {
            let accepted = true;
            try {
              preparedResult = freezeJsonValue(canonicalJsonClone(rawResult));
            } catch {
              accepted = false;
            }
            if (this.#transactionPoisoned) {
              throw precondition(
                "root storage reentry invalidated the transaction",
              );
            }
            if (!accepted) throw transactionReturnError();
            return undefined;
          }
          if (this.#transactionPoisoned) {
            throw precondition(
              "root storage reentry invalidated the transaction",
            );
          }
          return undefined;
        });
      } catch (error) {
        if (callbackThrew) throw callbackError;
        if (error instanceof AppError) throw safeAppError(error);
        throw storageError("SQLite storage transaction failed");
      }
      return preparedResult as T;
    } finally {
      if (revocable !== undefined) revocable.token.active = false;
      try {
        revocable?.revoke();
      } finally {
        this.#transactionActive = false;
        this.#transactionPoisoned = false;
      }
    }
  }

  getIncompleteRunSummaries(
    input: Parameters<StoragePort["getIncompleteRunSummaries"]>[0],
  ): ReturnType<StoragePort["getIncompleteRunSummaries"]> {
    this.#guardRootCall();
    this.#readyDelegate();
    return this.#repositoryOperation(() =>
      this.#planRunRepository!.getIncompleteRunSummaries(input),
    );
  }

  recoverAbandonedSnapshots(
    input: Parameters<StoragePort["recoverAbandonedSnapshots"]>[0],
  ): ReturnType<StoragePort["recoverAbandonedSnapshots"]> {
    this.#guardRootCall();
    this.#readyDelegate();
    return this.#repositoryOperation(() =>
      this.#snapshotRepository!.recoverAbandonedSnapshots(input),
    );
  }

  recoverAbandonedRuns(
    input: Parameters<StoragePort["recoverAbandonedRuns"]>[0],
  ): ReturnType<StoragePort["recoverAbandonedRuns"]> {
    this.#guardRootCall();
    this.#readyDelegate();
    return this.#repositoryOperation(() =>
      this.#planRunRepository!.recoverAbandonedRuns(input),
    );
  }

  recoverIncompleteSnapshots(
    now: Parameters<StoragePort["recoverIncompleteSnapshots"]>[0],
  ): ReturnType<StoragePort["recoverIncompleteSnapshots"]> {
    this.#guardRootCall();
    this.#readyDelegate();
    return this.#repositoryOperation(() =>
      this.#snapshotRepository!.recoverIncompleteSnapshots(now),
    );
  }

  recoverInterruptedRuns(
    now: Parameters<StoragePort["recoverInterruptedRuns"]>[0],
  ): ReturnType<StoragePort["recoverInterruptedRuns"]> {
    this.#guardRootCall();
    this.#readyDelegate();
    return this.#repositoryOperation(() =>
      this.#planRunRepository!.recoverInterruptedRuns(now),
    );
  }

  assertLease(
    input: Parameters<StorageTransaction["assertLease"]>[0],
  ): ReturnType<StorageTransaction["assertLease"]> {
    return this.#rootInvoke("assertLease", [input]) as ReturnType<
      StorageTransaction["assertLease"]
    >;
  }

  createSnapshot(
    input: Parameters<StorageTransaction["createSnapshot"]>[0],
  ): ReturnType<StorageTransaction["createSnapshot"]> {
    return this.#rootInvoke("createSnapshot", [input]) as ReturnType<
      StorageTransaction["createSnapshot"]
    >;
  }

  appendSnapshotBatch(
    input: Parameters<StorageTransaction["appendSnapshotBatch"]>[0],
  ): void {
    this.#rootInvoke("appendSnapshotBatch", [input]);
  }

  beginSnapshotVerification(
    input: Parameters<StorageTransaction["beginSnapshotVerification"]>[0],
  ): void {
    this.#rootInvoke("beginSnapshotVerification", [input]);
  }

  appendSnapshotVerificationBatch(
    input: Parameters<StorageTransaction["appendSnapshotVerificationBatch"]>[0],
  ): void {
    this.#rootInvoke("appendSnapshotVerificationBatch", [input]);
  }

  finishSnapshotVerification(
    input: Parameters<StorageTransaction["finishSnapshotVerification"]>[0],
  ): void {
    this.#rootInvoke("finishSnapshotVerification", [input]);
  }

  completeSnapshot(
    input: Parameters<StorageTransaction["completeSnapshot"]>[0],
  ): ReturnType<StorageTransaction["completeSnapshot"]> {
    return this.#rootInvoke("completeSnapshot", [input]) as ReturnType<
      StorageTransaction["completeSnapshot"]
    >;
  }

  failSnapshot(
    input: Parameters<StorageTransaction["failSnapshot"]>[0],
  ): ReturnType<StorageTransaction["failSnapshot"]> {
    return this.#rootInvoke("failSnapshot", [input]) as ReturnType<
      StorageTransaction["failSnapshot"]
    >;
  }

  getCompleteSnapshot(
    id: Parameters<StorageTransaction["getCompleteSnapshot"]>[0],
  ): ReturnType<StorageTransaction["getCompleteSnapshot"]> {
    return this.#rootInvoke("getCompleteSnapshot", [id]) as ReturnType<
      StorageTransaction["getCompleteSnapshot"]
    >;
  }

  getLatestCompleteSnapshot(
    binding: Parameters<StorageTransaction["getLatestCompleteSnapshot"]>[0],
  ): ReturnType<StorageTransaction["getLatestCompleteSnapshot"]> {
    return this.#rootInvoke("getLatestCompleteSnapshot", [
      binding,
    ]) as ReturnType<StorageTransaction["getLatestCompleteSnapshot"]>;
  }

  getRepositoryMetadata(
    id: Parameters<StorageTransaction["getRepositoryMetadata"]>[0],
  ): ReturnType<StorageTransaction["getRepositoryMetadata"]> {
    return this.#rootInvoke("getRepositoryMetadata", [id]) as ReturnType<
      StorageTransaction["getRepositoryMetadata"]
    >;
  }

  getSnapshotRepository(
    snapshotId: Parameters<StorageTransaction["getSnapshotRepository"]>[0],
    repositoryId: Parameters<StorageTransaction["getSnapshotRepository"]>[1],
  ): ReturnType<StorageTransaction["getSnapshotRepository"]> {
    return this.#rootInvoke("getSnapshotRepository", [
      snapshotId,
      repositoryId,
    ]) as ReturnType<StorageTransaction["getSnapshotRepository"]>;
  }

  getSnapshotListSummary(
    snapshotId: Parameters<StorageTransaction["getSnapshotListSummary"]>[0],
    listId: Parameters<StorageTransaction["getSnapshotListSummary"]>[1],
  ): ReturnType<StorageTransaction["getSnapshotListSummary"]> {
    return this.#rootInvoke("getSnapshotListSummary", [
      snapshotId,
      listId,
    ]) as ReturnType<StorageTransaction["getSnapshotListSummary"]>;
  }

  queryRepositories(
    input: Parameters<StorageTransaction["queryRepositories"]>[0],
  ): ReturnType<StorageTransaction["queryRepositories"]> {
    return this.#rootInvoke("queryRepositories", [input]) as ReturnType<
      StorageTransaction["queryRepositories"]
    >;
  }

  queryLists(
    input: Parameters<StorageTransaction["queryLists"]>[0],
  ): ReturnType<StorageTransaction["queryLists"]> {
    return this.#rootInvoke("queryLists", [input]) as ReturnType<
      StorageTransaction["queryLists"]
    >;
  }

  queryListMemberships(
    input: Parameters<StorageTransaction["queryListMemberships"]>[0],
  ): ReturnType<StorageTransaction["queryListMemberships"]> {
    return this.#rootInvoke("queryListMemberships", [input]) as ReturnType<
      StorageTransaction["queryListMemberships"]
    >;
  }

  hasStar(
    snapshotId: Parameters<StorageTransaction["hasStar"]>[0],
    repositoryId: Parameters<StorageTransaction["hasStar"]>[1],
  ): ReturnType<StorageTransaction["hasStar"]> {
    return this.#rootInvoke("hasStar", [
      snapshotId,
      repositoryId,
    ]) as ReturnType<StorageTransaction["hasStar"]>;
  }

  savePlan(input: Parameters<StorageTransaction["savePlan"]>[0]): void {
    this.#rootInvoke("savePlan", [input]);
  }

  getPlan(
    id: Parameters<StorageTransaction["getPlan"]>[0],
  ): ReturnType<StorageTransaction["getPlan"]> {
    return this.#rootInvoke("getPlan", [id]) as ReturnType<
      StorageTransaction["getPlan"]
    >;
  }

  compareAndSetPlanState(
    input: Parameters<StorageTransaction["compareAndSetPlanState"]>[0],
  ): ReturnType<StorageTransaction["compareAndSetPlanState"]> {
    return this.#rootInvoke("compareAndSetPlanState", [input]) as ReturnType<
      StorageTransaction["compareAndSetPlanState"]
    >;
  }

  createRun(input: Parameters<StorageTransaction["createRun"]>[0]): void {
    this.#rootInvoke("createRun", [input]);
  }

  getRun(
    id: Parameters<StorageTransaction["getRun"]>[0],
  ): ReturnType<StorageTransaction["getRun"]> {
    return this.#rootInvoke("getRun", [id]) as ReturnType<
      StorageTransaction["getRun"]
    >;
  }

  getLatestRunForPlan(
    planId: Parameters<StorageTransaction["getLatestRunForPlan"]>[0],
  ): ReturnType<StorageTransaction["getLatestRunForPlan"]> {
    return this.#rootInvoke("getLatestRunForPlan", [planId]) as ReturnType<
      StorageTransaction["getLatestRunForPlan"]
    >;
  }

  compareAndSetRunState(
    input: Parameters<StorageTransaction["compareAndSetRunState"]>[0],
  ): ReturnType<StorageTransaction["compareAndSetRunState"]> {
    return this.#rootInvoke("compareAndSetRunState", [input]) as ReturnType<
      StorageTransaction["compareAndSetRunState"]
    >;
  }

  createRunOperation(
    input: Parameters<StorageTransaction["createRunOperation"]>[0],
  ): void {
    this.#rootInvoke("createRunOperation", [input]);
  }

  startRunOperation(
    input: Parameters<StorageTransaction["startRunOperation"]>[0],
  ): ReturnType<StorageTransaction["startRunOperation"]> {
    return this.#rootInvoke("startRunOperation", [input]) as ReturnType<
      StorageTransaction["startRunOperation"]
    >;
  }

  getRunOperation(
    input: Parameters<StorageTransaction["getRunOperation"]>[0],
  ): ReturnType<StorageTransaction["getRunOperation"]> {
    return this.#rootInvoke("getRunOperation", [input]) as ReturnType<
      StorageTransaction["getRunOperation"]
    >;
  }

  retryRunOperation(
    input: Parameters<StorageTransaction["retryRunOperation"]>[0],
  ): ReturnType<StorageTransaction["retryRunOperation"]> {
    return this.#rootInvoke("retryRunOperation", [input]) as ReturnType<
      StorageTransaction["retryRunOperation"]
    >;
  }

  listRunOperations(
    runId: Parameters<StorageTransaction["listRunOperations"]>[0],
  ): ReturnType<StorageTransaction["listRunOperations"]> {
    return this.#rootInvoke("listRunOperations", [runId]) as ReturnType<
      StorageTransaction["listRunOperations"]
    >;
  }

  listRunOperationsPage(
    input: Parameters<StorageTransaction["listRunOperationsPage"]>[0],
  ): ReturnType<StorageTransaction["listRunOperationsPage"]> {
    return this.#rootInvoke("listRunOperationsPage", [input]) as ReturnType<
      StorageTransaction["listRunOperationsPage"]
    >;
  }

  finishRunOperation(
    input: Parameters<StorageTransaction["finishRunOperation"]>[0],
  ): ReturnType<StorageTransaction["finishRunOperation"]> {
    return this.#rootInvoke("finishRunOperation", [input]) as ReturnType<
      StorageTransaction["finishRunOperation"]
    >;
  }

  reconcileRunOperation(
    input: Parameters<StorageTransaction["reconcileRunOperation"]>[0],
  ): ReturnType<StorageTransaction["reconcileRunOperation"]> {
    return this.#rootInvoke("reconcileRunOperation", [input]) as ReturnType<
      StorageTransaction["reconcileRunOperation"]
    >;
  }

  getRunOperationAttempt(
    input: Parameters<StorageTransaction["getRunOperationAttempt"]>[0],
  ): ReturnType<StorageTransaction["getRunOperationAttempt"]> {
    return this.#rootInvoke("getRunOperationAttempt", [input]) as ReturnType<
      StorageTransaction["getRunOperationAttempt"]
    >;
  }

  listRunOperationAttemptsPage(
    input: Parameters<StorageTransaction["listRunOperationAttemptsPage"]>[0],
  ): ReturnType<StorageTransaction["listRunOperationAttemptsPage"]> {
    return this.#rootInvoke("listRunOperationAttemptsPage", [
      input,
    ]) as ReturnType<StorageTransaction["listRunOperationAttemptsPage"]>;
  }

  listRunOperationReconciliationsPage(
    input: Parameters<
      StorageTransaction["listRunOperationReconciliationsPage"]
    >[0],
  ): ReturnType<StorageTransaction["listRunOperationReconciliationsPage"]> {
    return this.#rootInvoke("listRunOperationReconciliationsPage", [
      input,
    ]) as ReturnType<StorageTransaction["listRunOperationReconciliationsPage"]>;
  }

  acquireLease(
    input: Parameters<StorageTransaction["acquireLease"]>[0],
  ): ReturnType<StorageTransaction["acquireLease"]> {
    return this.#rootInvoke("acquireLease", [input]) as ReturnType<
      StorageTransaction["acquireLease"]
    >;
  }

  renewLease(
    input: Parameters<StorageTransaction["renewLease"]>[0],
  ): ReturnType<StorageTransaction["renewLease"]> {
    return this.#rootInvoke("renewLease", [input]) as ReturnType<
      StorageTransaction["renewLease"]
    >;
  }

  releaseLease(input: Parameters<StorageTransaction["releaseLease"]>[0]): void {
    this.#rootInvoke("releaseLease", [input]);
  }

  close(): void {
    this.#guardRootCall();
    if (this.#lifecycle === "closed") return;
    if (this.#lifecycle === "migrating") {
      throw precondition("SQLite storage migration is active");
    }
    const database = this.#database;
    this.#database = undefined;
    this.#clearRepositories();
    this.#lifecycle = "closed";
    if (database === undefined) return;
    try {
      database.close();
    } catch {
      throw storageError("SQLite storage close failed");
    }
  }
}
