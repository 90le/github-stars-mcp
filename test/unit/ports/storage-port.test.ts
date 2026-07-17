import { Buffer } from "node:buffer";
import { Hash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { describe, expect, test, vi } from "vitest";
import type {
  LeaseGuard,
  StoragePort,
  StorageTransaction,
} from "../../../src/app/ports/storage-port.js";
import {
  canonicalJson,
  sha256Hex,
} from "../../../src/domain/canonical-json.js";
import { AppError } from "../../../src/domain/errors.js";
import {
  asPlanId,
  asRepositoryId,
  asSnapshotId,
  asUserListId,
} from "../../../src/domain/ids.js";
import { parseChangePlan } from "../../../src/domain/plan.js";
import {
  repositorySchema,
  type Repository,
} from "../../../src/domain/repository.js";
import { parseChangeRun, parseRunOperation } from "../../../src/domain/run.js";
import {
  parseSnapshotBatch,
  parseSnapshotDraft,
  type SnapshotBatch,
} from "../../../src/domain/snapshot.js";
import {
  accountBindingFixture,
  changePlanFixture,
  changeRunFixture,
  pendingOperationFixture,
  repositoryInputFixture,
  snapshotBatchFixture,
  snapshotDraftFixture,
} from "../../fixtures/domain.js";
import {
  createMemoryStorage,
  registerRepositoryVersionForTest,
} from "../../fixtures/memory-storage.js";

const SYNC_GUARD = {
  name: "sync:U_1",
  ownerId: "sync-owner",
  now: "2026-07-16T00:01:00.000Z",
} as const;

const APPLY_GUARD = {
  name: "apply:U_1",
  ownerId: "apply-owner",
  now: "2026-07-16T02:01:00.000Z",
} as const;

function openStore(): StoragePort {
  const store = createMemoryStorage({ cursorKey: new Uint8Array(32).fill(7) });
  store.migrate();
  return store;
}

const definePropertyForTest = Object.defineProperty;
const deletePropertyForTest = Reflect.deleteProperty;
const getOwnPropertyDescriptorForTest = Object.getOwnPropertyDescriptor;

function defineTemporaryOwnPropertyForTest(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor,
): () => void {
  const previous = getOwnPropertyDescriptorForTest(target, property);
  definePropertyForTest(target, property, descriptor);
  return () => {
    if (previous === undefined) {
      deletePropertyForTest(target, property);
    } else {
      definePropertyForTest(target, property, previous);
    }
  };
}

function replaceOwnPropertyForTest(
  target: object,
  property: PropertyKey,
  value: unknown,
): () => void {
  const descriptor = getOwnPropertyDescriptorForTest(target, property);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new Error(`Expected mutable data property ${String(property)}`);
  }
  return defineTemporaryOwnPropertyForTest(target, property, {
    configurable: descriptor.configurable === true,
    enumerable: descriptor.enumerable === true,
    value,
    writable: descriptor.writable === true,
  });
}

function acquireSync(store: StoragePort): void {
  expect(
    store.acquireLease({
      name: SYNC_GUARD.name,
      ownerId: SYNC_GUARD.ownerId,
      now: "2026-07-16T00:00:00.000Z",
      expiresAt: "2026-07-16T00:10:00.000Z",
    }),
  ).toMatchObject({ ownerId: SYNC_GUARD.ownerId });
}

function verificationBatch(batch: SnapshotBatch) {
  return {
    stars: batch.stars,
    lists: batch.lists,
    memberships: batch.memberships,
  };
}

function completeSnapshot(
  store: StoragePort,
  options: {
    readonly id?: string;
    readonly batch?: SnapshotBatch;
    readonly verification?: ReturnType<typeof verificationBatch>;
    readonly draftCoverage?: "collecting" | "unavailable" | "omitted";
    readonly finalCoverage?: "complete" | "unavailable" | "omitted";
    readonly guard?: LeaseGuard;
  } = {},
) {
  const guard = options.guard ?? SYNC_GUARD;
  const batch = options.batch ?? snapshotBatchFixture;
  const draft = parseSnapshotDraft({
    ...snapshotDraftFixture,
    id: options.id ?? snapshotDraftFixture.id,
    listCoverage: options.draftCoverage ?? "collecting",
  });
  store.createSnapshot({ draft, lease: guard });
  store.appendSnapshotBatch({ id: draft.id, batch, lease: guard });
  const finalCoverage = options.finalCoverage ?? "complete";
  store.beginSnapshotVerification({
    id: draft.id,
    listCoverage: finalCoverage,
    lease: guard,
  });
  store.appendSnapshotVerificationBatch({
    id: draft.id,
    batch: options.verification ?? verificationBatch(batch),
    lease: guard,
  });
  store.finishSnapshotVerification({ id: draft.id, lease: guard });
  return store.completeSnapshot({
    id: draft.id,
    completedAt: "2026-07-16T00:02:00.000Z",
    listCoverage: finalCoverage,
    counts: {
      repositories: batch.repositories.length,
      stars: batch.stars.length,
      lists: batch.lists.length,
      memberships: batch.memberships.length,
    },
    warningCount: 0,
    sourceRateLimit: null,
    lease: guard,
  });
}

function twoItemBatch(): SnapshotBatch {
  return parseSnapshotBatch({
    repositories: [
      ...snapshotBatchFixture.repositories,
      {
        repository: {
          ...repositoryInputFixture,
          repositoryId: "R_2",
          repositoryDatabaseId: "43",
          name: "Agents",
          fullName: "OpenAI/Agents",
          url: "https://github.com/OpenAI/Agents",
          primaryLanguage: "__proto__",
          stargazerCount: 20,
        },
        observedAt: "2026-07-16T00:00:00.000Z",
      },
    ],
    stars: [
      ...snapshotBatchFixture.stars,
      {
        repositoryId: "R_2",
        starredAt: "2026-07-15T13:00:00.000Z",
      },
    ],
    lists: [
      ...snapshotBatchFixture.lists,
      {
        listId: "UL_2",
        name: "Tools",
        slug: "tools",
        description: "tooling",
        isPrivate: true,
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        lastAddedAt: null,
      },
    ],
    memberships: [
      ...snapshotBatchFixture.memberships,
      { listId: "UL_1", repositoryId: "R_2" },
      { listId: "UL_2", repositoryId: "R_1" },
    ],
  });
}

function prepareRun(store: StoragePort): void {
  store.acquireLease({
    name: APPLY_GUARD.name,
    ownerId: APPLY_GUARD.ownerId,
    now: "2026-07-16T02:00:00.000Z",
    expiresAt: "2026-07-16T02:10:00.000Z",
  });
  store.savePlan(changePlanFixture);
  store.compareAndSetPlanState({
    planId: changePlanFixture.id,
    expected: ["ready"],
    next: "applying",
  });
  store.createRun({ run: changeRunFixture, lease: APPLY_GUARD });
  store.compareAndSetRunState({
    runId: changeRunFixture.id,
    expected: ["pending"],
    next: "running",
    finishedAt: null,
    lease: APPLY_GUARD,
  });
  store.createRunOperation({
    operation: pendingOperationFixture,
    lease: APPLY_GUARD,
  });
}

function retryableError() {
  return {
    code: "GITHUB_UNAVAILABLE",
    message: "transport failed",
    retryable: true,
    details: {},
  } as const;
}

function unknownError() {
  return {
    code: "RECONCILIATION_REQUIRED",
    message: "outcome unknown",
    retryable: false,
    details: {},
  } as const;
}

describe("synchronous revocable transactions", () => {
  test("commits synchronously and revokes leaked facades", () => {
    const store = openStore();
    let leaked: StorageTransaction | undefined;
    expect(
      store.withTransaction((tx) => {
        leaked = tx;
        tx.savePlan(changePlanFixture);
        return "committed";
      }),
    ).toBe("committed");
    expect(store.getPlan(changePlanFixture.id)).toEqual(changePlanFixture);
    expect(() => leaked?.getPlan(changePlanFixture.id)).toThrow();
    store.close();
  });

  test("rolls back throws, native Promises, proxies, and descriptor thenables", () => {
    const transactionResults: readonly unknown[] = [
      Promise.resolve("no"),
      new Proxy({}, {}),
      Object.create({
        then() {
          return undefined;
        },
      }),
    ];
    for (const result of transactionResults) {
      const store = openStore();
      expect(() =>
        store.withTransaction((tx) => {
          tx.savePlan(changePlanFixture);
          return result;
        }),
      ).toThrow(/synchronous|thenable/iu);
      expect(store.getPlan(changePlanFixture.id)).toBeNull();
    }

    const store = openStore();
    let getterCalls = 0;
    const accessorThen = {};
    Object.defineProperty(accessorThen, "then", {
      get() {
        getterCalls += 1;
        return () => undefined;
      },
    });
    expect(() =>
      store.withTransaction((tx) => {
        tx.savePlan(changePlanFixture);
        return accessorThen;
      }),
    ).toThrow(/synchronous|thenable/iu);
    expect(getterCalls).toBe(0);
    expect(store.getPlan(changePlanFixture.id)).toBeNull();

    let rolledBackFacade: StorageTransaction | undefined;
    expect(() =>
      store.withTransaction((tx) => {
        rolledBackFacade = tx;
        tx.savePlan(changePlanFixture);
        throw new Error("rollback");
      }),
    ).toThrow(/rollback/u);
    expect(store.getPlan(changePlanFixture.id)).toBeNull();
    expect(() => rolledBackFacade?.getPlan(changePlanFixture.id)).toThrow();
  });

  test("rejects dangerous return graphs before prototype traps can commit", () => {
    const trapStore = openStore();
    let reentryCaught = 0;
    let getTrapCalls = 0;
    const proxyPrototype = new Proxy(Object.create(null) as object, {
      get(_target, property) {
        getTrapCalls += 1;
        return property === "then" ? () => undefined : undefined;
      },
      getOwnPropertyDescriptor() {
        try {
          trapStore.getPlan(changePlanFixture.id);
        } catch {
          reentryCaught += 1;
        }
        return undefined;
      },
    });
    const disguised = Object.create(proxyPrototype) as object;

    let caught: unknown;
    try {
      trapStore.withTransaction((tx) => {
        tx.savePlan(changePlanFixture);
        return disguised;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(reentryCaught).toBe(0);
    expect(getTrapCalls).toBe(0);
    expect(trapStore.getPlan(changePlanFixture.id)).toBeNull();

    const nestedStore = openStore();
    expect(() =>
      nestedStore.withTransaction((tx) => {
        tx.savePlan(changePlanFixture);
        return { nested: new Proxy({}, {}) };
      }),
    ).toThrow(/synchronous|proxy|return/iu);
    expect(nestedStore.getPlan(changePlanFixture.id)).toBeNull();
  });

  test("rejects noncanonical result graphs without invoking user code", () => {
    let getterCalls = 0;
    let proxyTrapCalls = 0;
    const hiddenProxy = new Proxy(
      {},
      {
        get() {
          proxyTrapCalls += 1;
          return undefined;
        },
        getOwnPropertyDescriptor() {
          proxyTrapCalls += 1;
          return undefined;
        },
        getPrototypeOf() {
          proxyTrapCalls += 1;
          return Object.prototype;
        },
        ownKeys() {
          proxyTrapCalls += 1;
          return [];
        },
      },
    );
    const customPrototype = { nested: hiddenProxy };
    Object.defineProperty(customPrototype, "accessor", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return hiddenProxy;
      },
    });
    const weakKey = {};
    class PrivateResult {
      readonly #secret = "hidden";

      reveal(): string {
        return this.#secret;
      }
    }
    const accessorResult = {};
    Object.defineProperty(accessorResult, "hidden", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "hidden";
      },
    });
    const symbolResult = { visible: true };
    Object.defineProperty(symbolResult, Symbol("hidden"), {
      enumerable: true,
      value: hiddenProxy,
    });
    const sparseResult = new Array<unknown>(1);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const dangerousResults = [
      new Map<unknown, unknown>([["nested", hiddenProxy]]),
      new Set<unknown>([Promise.resolve("nested")]),
      Object.create(customPrototype) as object,
      new WeakMap<object, unknown>([[weakKey, hiddenProxy]]),
      new WeakSet<object>([weakKey]),
      Promise.resolve("hidden"),
      new PrivateResult(),
      () => "hidden",
      accessorResult,
      symbolResult,
      sparseResult,
      cyclic,
    ] as const;

    for (const result of dangerousResults) {
      const store = openStore();
      expect(() =>
        store.withTransaction((tx) => {
          tx.savePlan(changePlanFixture);
          return result;
        }),
      ).toThrow(/synchronous|proxy|return/iu);
      expect(store.getPlan(changePlanFixture.id)).toBeNull();
    }
    expect(getterCalls).toBe(0);
    expect(proxyTrapCalls).toBe(0);
  });

  test("rejects recognizable exotics after prototype erasure without inspecting their contents", () => {
    let proxyTrapCalls = 0;
    const hiddenProxy = new Proxy(
      {},
      {
        get() {
          proxyTrapCalls += 1;
          return undefined;
        },
        getOwnPropertyDescriptor() {
          proxyTrapCalls += 1;
          return undefined;
        },
        getPrototypeOf() {
          proxyTrapCalls += 1;
          return Object.prototype;
        },
        ownKeys() {
          proxyTrapCalls += 1;
          return [];
        },
      },
    );
    const hiddenPromise = Promise.resolve("hidden");
    function erasePrototype<T extends object>(value: T): T {
      Object.setPrototypeOf(value, null);
      return value;
    }
    const weakKey = {};
    const recognizableResults = [
      erasePrototype(new Map<unknown, unknown>([["hidden", hiddenProxy]])),
      erasePrototype(new Set<unknown>([hiddenPromise])),
      erasePrototype(new WeakMap<object, unknown>([[weakKey, hiddenProxy]])),
      erasePrototype(new WeakSet<object>([weakKey])),
      erasePrototype(hiddenPromise),
      erasePrototype(new Date("2026-07-16T00:00:00.000Z")),
      erasePrototype(/hidden/gu),
      erasePrototype(new Error("hidden")),
      erasePrototype(new ArrayBuffer(8)),
      erasePrototype(new SharedArrayBuffer(8)),
      erasePrototype(new Uint8Array([1, 2, 3])),
      erasePrototype(new DataView(new ArrayBuffer(8))),
    ] as const;

    for (const result of recognizableResults) {
      const store = openStore();
      expect(() =>
        store.withTransaction((tx) => {
          tx.savePlan(changePlanFixture);
          return result;
        }),
      ).toThrow(/canonical|return|synchronous/iu);
      expect(store.getPlan(changePlanFixture.id)).toBeNull();
    }
    expect(proxyTrapCalls).toBe(0);
  });

  test("captures exotic brand predicates before callbacks can replace them", () => {
    const originalIsProxy = utilTypes.isProxy;
    const originalIsMap = utilTypes.isMap;
    const proxyStore = openStore();
    const mapStore = openStore();
    let proxyTrapCalls = 0;
    const disguisedProxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          proxyTrapCalls += 1;
          return undefined;
        },
        getPrototypeOf() {
          proxyTrapCalls += 1;
          return null;
        },
        ownKeys() {
          proxyTrapCalls += 1;
          return [];
        },
      },
    );
    const disguisedMap = new Map<unknown, unknown>([
      ["hidden", Promise.resolve("hidden")],
    ]);
    Object.setPrototypeOf(disguisedMap, null);
    let proxyError: unknown;
    let mapError: unknown;
    let restoreIsProxy: (() => void) | undefined;
    let restoreIsMap: (() => void) | undefined;

    try {
      proxyStore.withTransaction((tx) => {
        tx.savePlan(changePlanFixture);
        restoreIsProxy = replaceOwnPropertyForTest(
          utilTypes,
          "isProxy",
          () => false,
        );
        return disguisedProxy;
      });
    } catch (error) {
      proxyError = error;
    } finally {
      restoreIsProxy?.();
    }
    try {
      mapStore.withTransaction((tx) => {
        tx.savePlan(changePlanFixture);
        restoreIsMap = replaceOwnPropertyForTest(
          utilTypes,
          "isMap",
          () => false,
        );
        return disguisedMap;
      });
    } catch (error) {
      mapError = error;
    } finally {
      restoreIsMap?.();
    }

    expect(utilTypes.isProxy).toBe(originalIsProxy);
    expect(utilTypes.isMap).toBe(originalIsMap);
    expect(proxyError).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mapError).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(proxyTrapCalls).toBe(0);
    expect(proxyStore.getPlan(changePlanFixture.id)).toBeNull();
    expect(mapStore.getPlan(changePlanFixture.id)).toBeNull();
  });

  test("discards undetectable private slots and returns only a frozen detached clone", () => {
    let proxyTrapCalls = 0;
    const hiddenProxy = new Proxy(
      {},
      {
        get() {
          proxyTrapCalls += 1;
          return undefined;
        },
        getOwnPropertyDescriptor() {
          proxyTrapCalls += 1;
          return undefined;
        },
        getPrototypeOf() {
          proxyTrapCalls += 1;
          return Object.prototype;
        },
        ownKeys() {
          proxyTrapCalls += 1;
          return [];
        },
      },
    );
    class HiddenResult {
      readonly #proxy = hiddenProxy;
      readonly #promise = Promise.resolve("hidden");

      reveal(): readonly unknown[] {
        return [this.#proxy, this.#promise];
      }
    }
    const disguised = new HiddenResult();
    Object.setPrototypeOf(disguised, null);
    const store = openStore();

    const returned = store.withTransaction((tx) => {
      tx.savePlan(changePlanFixture);
      return disguised;
    });

    expect(returned).toEqual({});
    expect(returned).not.toBe(disguised);
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Reflect.ownKeys(returned as object)).toEqual([]);
    expect(Reflect.has(returned as object, "reveal")).toBe(false);
    expect(proxyTrapCalls).toBe(0);
    expect(store.getPlan(changePlanFixture.id)).toEqual(changePlanFixture);
  });

  test("returns primitives by value and canonical objects as frozen detached clones", () => {
    const primitives = [undefined, null, true, 42, "committed"] as const;
    for (const primitive of primitives) {
      const store = openStore();
      expect(
        store.withTransaction((tx) => {
          tx.savePlan(changePlanFixture);
          return primitive;
        }),
      ).toBe(primitive);
      expect(store.getPlan(changePlanFixture.id)).toEqual(changePlanFixture);
    }

    const nullPrototype = Object.assign(
      Object.create(null) as Record<string, unknown>,
      {
        status: "committed",
      },
    );
    const nullPrototypeStore = openStore();
    const clonedNullPrototype = nullPrototypeStore.withTransaction((tx) => {
      tx.savePlan(changePlanFixture);
      return nullPrototype;
    });
    expect(clonedNullPrototype).toEqual({ status: "committed" });
    expect(clonedNullPrototype).not.toBe(nullPrototype);
    expect(Object.getPrototypeOf(clonedNullPrototype)).toBe(Object.prototype);
    expect(Object.isFrozen(clonedNullPrototype)).toBe(true);

    const arraySource = [{ status: "committed" }];
    const arrayStore = openStore();
    const clonedArray = arrayStore.withTransaction((tx) => {
      tx.savePlan(changePlanFixture);
      return arraySource;
    });
    expect(clonedArray).toEqual(arraySource);
    expect(clonedArray).not.toBe(arraySource);
    expect(clonedArray[0]).not.toBe(arraySource[0]);
    expect(Object.isFrozen(clonedArray)).toBe(true);
    expect(Object.isFrozen(clonedArray[0])).toBe(true);

    const source = {
      nested: { status: "committed" },
      rows: [{ value: 1 }],
    };
    const store = openStore();
    const returned = store.withTransaction((tx) => {
      tx.savePlan(changePlanFixture);
      return source;
    });
    expect(returned).toEqual(source);
    expect(returned).not.toBe(source);
    expect(returned.nested).not.toBe(source.nested);
    expect(returned.rows).not.toBe(source.rows);
    expect(returned.rows[0]).not.toBe(source.rows[0]);
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned.nested)).toBe(true);
    expect(Object.isFrozen(returned.rows)).toBe(true);
    expect(Object.isFrozen(returned.rows[0])).toBe(true);
    expect(Reflect.set(returned.nested, "status", "escaped")).toBe(false);
    source.nested.status = "mutated";
    source.rows[0] = { value: 2 };
    expect(returned).toEqual({
      nested: { status: "committed" },
      rows: [{ value: 1 }],
    });
    expect(store.getPlan(changePlanFixture.id)).toEqual(changePlanFixture);
  });

  test("captures JSON clone and recursive-freeze intrinsics before callbacks can replace them", () => {
    const originalJsonParse = JSON.parse;
    const originalObjectFreeze = Object.freeze;
    const originalObjectKeys = Object.keys;
    const source = {
      nested: { status: "committed" },
      rows: [{ value: 1 }],
    };
    const store = openStore();
    let returned: typeof source | undefined;
    let caught: unknown;
    let restoreJsonParse: (() => void) | undefined;
    let restoreObjectFreeze: (() => void) | undefined;
    let restoreObjectKeys: (() => void) | undefined;

    try {
      try {
        returned = store.withTransaction((tx) => {
          tx.savePlan(changePlanFixture);
          restoreJsonParse = replaceOwnPropertyForTest(
            JSON,
            "parse",
            () => source,
          );
          restoreObjectFreeze = replaceOwnPropertyForTest(
            Object,
            "freeze",
            <T>(value: T): T => value,
          );
          restoreObjectKeys = replaceOwnPropertyForTest(
            Object,
            "keys",
            () => [],
          );
          return source;
        });
      } catch (error) {
        caught = error;
      }
    } finally {
      restoreObjectKeys?.();
      restoreObjectFreeze?.();
      restoreJsonParse?.();
    }

    expect(JSON.parse).toBe(originalJsonParse);
    expect(Object.freeze).toBe(originalObjectFreeze);
    expect(Object.keys).toBe(originalObjectKeys);
    expect(caught).toBeUndefined();
    expect(returned).toEqual(source);
    expect(returned).not.toBe(source);
    expect(returned?.nested).not.toBe(source.nested);
    expect(returned?.rows).not.toBe(source.rows);
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned?.nested)).toBe(true);
    expect(Object.isFrozen(returned?.rows)).toBe(true);
    expect(Object.isFrozen(returned?.rows[0])).toBe(true);
    source.nested.status = "mutated";
    source.rows[0] = { value: 2 };
    expect(returned).toEqual({
      nested: { status: "committed" },
      rows: [{ value: 1 }],
    });
    expect(store.getPlan(changePlanFixture.id)).toEqual(changePlanFixture);
  });

  /* eslint-disable @typescript-eslint/unbound-method -- This regression test records and compares method identities without invoking them unbound. */
  test("captures every mutable canonical and hash operation used after callback entry", () => {
    const originals = {
      jsonStringify: JSON.stringify,
      objectFreeze: Object.freeze,
      objectHasOwn: Object.hasOwn,
      objectIs: Object.is,
      objectKeys: Object.keys,
      reflectApply: Reflect.apply,
      reflectDefineProperty: Reflect.defineProperty,
      reflectGetOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
      reflectGetPrototypeOf: Reflect.getPrototypeOf,
      reflectOwnKeys: Reflect.ownKeys,
      reflectSetPrototypeOf: Reflect.setPrototypeOf,
      arrayIsArray: Array.isArray,
      arrayIterator: Array.prototype[Symbol.iterator],
      arrayJoin: Array.prototype.join,
      arrayPush: Array.prototype.push,
      arraySort: Array.prototype.sort,
      arrayZeroDescriptor: getOwnPropertyDescriptorForTest(
        Array.prototype,
        "0",
      ),
      numberIsFinite: Number.isFinite,
      numberIsSafeInteger: Number.isSafeInteger,
      bufferByteLength: Buffer.byteLength,
      setConstructor: globalThis.Set,
      stringConstructor: globalThis.String,
      setAdd: Set.prototype.add,
      setDelete: Set.prototype.delete,
      setHas: Set.prototype.has,
      hashUpdate: Hash.prototype.update,
      hashDigest: Hash.prototype.digest,
    };
    const restorers: Array<() => void> = [];
    function patch(
      target: object,
      property: PropertyKey,
      value: unknown,
    ): void {
      restorers[restorers.length] = replaceOwnPropertyForTest(
        target,
        property,
        value,
      );
    }

    const store = openStore();
    let returned:
      | {
          canonical: string;
          hash: string;
          payload: { z: number; a: readonly [boolean, null]; n: number };
        }
      | undefined;
    let caught: unknown;
    let arrayPrototypeSetterCalls = 0;

    try {
      try {
        returned = store.withTransaction((tx) => {
          tx.savePlan(changePlanFixture);
          patch(JSON, "stringify", () => '"tampered"');
          patch(Object, "freeze", <T>(value: T): T => value);
          patch(Object, "hasOwn", () => false);
          patch(Object, "is", () => false);
          patch(Object, "keys", () => []);
          patch(Reflect, "apply", () => {
            throw new Error("mutable Reflect.apply must not run");
          });
          patch(Reflect, "defineProperty", () => false);
          patch(Reflect, "getOwnPropertyDescriptor", () => undefined);
          patch(Reflect, "getPrototypeOf", () => null);
          patch(Reflect, "ownKeys", () => []);
          patch(Reflect, "setPrototypeOf", () => false);
          patch(Array, "isArray", () => false);
          patch(Number, "isFinite", () => false);
          patch(Number, "isSafeInteger", () => false);
          patch(Buffer, "byteLength", () => 0);
          patch(
            Set.prototype,
            "add",
            function poisonedSetAdd(this: Set<unknown>) {
              return this;
            },
          );
          patch(Set.prototype, "delete", () => false);
          patch(Set.prototype, "has", () => false);
          patch(
            Hash.prototype,
            "update",
            function poisonedHashUpdate(this: Hash) {
              return this;
            },
          );
          patch(Hash.prototype, "digest", () => "tampered");
          patch(
            globalThis,
            "Set",
            class PoisonedSet {
              readonly poisoned = true;
            },
          );
          patch(globalThis, "String", () => "tampered");
          patch(
            Array.prototype,
            "sort",
            function poisonedSort(this: unknown[]) {
              return this;
            },
          );
          patch(Array.prototype, Symbol.iterator, () => {
            throw new Error("mutable Array iterator must not run");
          });
          patch(Array.prototype, "join", () => "tampered");
          patch(Array.prototype, "push", () => 0);
          restorers[restorers.length] = defineTemporaryOwnPropertyForTest(
            Array.prototype,
            "0",
            {
              configurable: true,
              set() {
                arrayPrototypeSetterCalls += 1;
              },
            },
          );
          const payload = {
            z: 1,
            a: [true, null] as const,
            n: -0,
          };
          return {
            canonical: canonicalJson(payload),
            hash: sha256Hex("abc"),
            payload,
          };
        });
      } catch (error) {
        caught = error;
      }
    } finally {
      for (let index = restorers.length - 1; index >= 0; index -= 1) {
        restorers[index]?.();
      }
    }

    expect(JSON.stringify).toBe(originals.jsonStringify);
    expect(Object.freeze).toBe(originals.objectFreeze);
    expect(Object.hasOwn).toBe(originals.objectHasOwn);
    expect(Object.is).toBe(originals.objectIs);
    expect(Object.keys).toBe(originals.objectKeys);
    expect(Reflect.apply).toBe(originals.reflectApply);
    expect(Reflect.defineProperty).toBe(originals.reflectDefineProperty);
    expect(Reflect.getOwnPropertyDescriptor).toBe(
      originals.reflectGetOwnPropertyDescriptor,
    );
    expect(Reflect.getPrototypeOf).toBe(originals.reflectGetPrototypeOf);
    expect(Reflect.ownKeys).toBe(originals.reflectOwnKeys);
    expect(Reflect.setPrototypeOf).toBe(originals.reflectSetPrototypeOf);
    expect(Array.isArray).toBe(originals.arrayIsArray);
    expect(Array.prototype[Symbol.iterator]).toBe(originals.arrayIterator);
    expect(Array.prototype.join).toBe(originals.arrayJoin);
    expect(Array.prototype.push).toBe(originals.arrayPush);
    expect(Array.prototype.sort).toBe(originals.arraySort);
    expect(Number.isFinite).toBe(originals.numberIsFinite);
    expect(Number.isSafeInteger).toBe(originals.numberIsSafeInteger);
    expect(Buffer.byteLength).toBe(originals.bufferByteLength);
    expect(globalThis.Set).toBe(originals.setConstructor);
    expect(globalThis.String).toBe(originals.stringConstructor);
    expect(Set.prototype.add).toBe(originals.setAdd);
    expect(Set.prototype.delete).toBe(originals.setDelete);
    expect(Set.prototype.has).toBe(originals.setHas);
    expect(Hash.prototype.update).toBe(originals.hashUpdate);
    expect(Hash.prototype.digest).toBe(originals.hashDigest);
    expect(getOwnPropertyDescriptorForTest(Array.prototype, "0")).toEqual(
      originals.arrayZeroDescriptor,
    );
    expect(arrayPrototypeSetterCalls).toBe(0);
    expect(caught).toBeUndefined();
    expect(returned).toEqual({
      canonical: '{"a":[true,null],"n":0,"z":1}',
      hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      payload: { z: 1, a: [true, null], n: 0 },
    });
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned?.payload)).toBe(true);
    expect(Object.isFrozen(returned?.payload.a)).toBe(true);
    expect(store.getPlan(changePlanFixture.id)).toEqual(changePlanFixture);
  });
  /* eslint-enable @typescript-eslint/unbound-method */

  test("poisons caught root reentry and nested transactions", () => {
    const store = openStore();
    expect(() =>
      store.withTransaction((tx) => {
        tx.savePlan(changePlanFixture);
        try {
          store.getPlan(changePlanFixture.id);
        } catch {
          // A caught root call still invalidates the transaction.
        }
        return null;
      }),
    ).toThrow(/reentry|root/iu);
    expect(store.getPlan(changePlanFixture.id)).toBeNull();

    expect(() =>
      store.withTransaction((tx) => {
        tx.savePlan(changePlanFixture);
        try {
          store.withTransaction(() => null);
        } catch {
          // A caught nested transaction still invalidates the outer one.
        }
        return null;
      }),
    ).toThrow(/reentry|root/iu);
    expect(store.getPlan(changePlanFixture.id)).toBeNull();
  });

  test("captures structuredClone before callers can alias transaction state", () => {
    const originalStructuredClone = globalThis.structuredClone;
    const store = openStore();
    const restoreStructuredClone = replaceOwnPropertyForTest(
      globalThis,
      "structuredClone",
      <T>(value: T): T => value,
    );

    try {
      expect(() =>
        store.withTransaction((tx) => {
          tx.savePlan(changePlanFixture);
          throw new Error("rollback");
        }),
      ).toThrow(/rollback/u);
    } finally {
      restoreStructuredClone();
    }

    expect(globalThis.structuredClone).toBe(originalStructuredClone);
    expect(store.getPlan(changePlanFixture.id)).toBeNull();
  });

  test("captures transaction constructors before callers can replace them", () => {
    const store = openStore();
    const restorers = [
      replaceOwnPropertyForTest(
        globalThis,
        "Map",
        function PoisonedMap(): never {
          throw new Error("mutable Map constructor must not run");
        },
      ),
      replaceOwnPropertyForTest(Object, "create", () => {
        throw new Error("mutable Object.create must not run");
      }),
      replaceOwnPropertyForTest(Proxy, "revocable", () => {
        throw new Error("mutable Proxy.revocable must not run");
      }),
    ];
    let caught: unknown;

    try {
      try {
        store.withTransaction(() => null);
      } catch (error) {
        caught = error;
      }
    } finally {
      for (let index = restorers.length - 1; index >= 0; index -= 1) {
        restorers[index]?.();
      }
    }

    expect(caught).toBeUndefined();
    store.withTransaction((tx) => tx.savePlan(changePlanFixture));
    expect(store.getPlan(changePlanFixture.id)).toEqual(changePlanFixture);
  });

  test("cleans transaction flags even when the captured revoke throws", async () => {
    const applyForTest = Reflect.apply;
    const originalProxyRevocable = Proxy.revocable;
    vi.resetModules();
    const restoreProxyRevocable = replaceOwnPropertyForTest(
      Proxy,
      "revocable",
      <T extends object>(
        target: T,
        handler: ProxyHandler<T>,
      ): { proxy: T; revoke: () => void } => {
        const pair = applyForTest(originalProxyRevocable, Proxy, [
          target,
          handler,
        ]);
        return {
          proxy: pair.proxy,
          revoke: () => {
            pair.revoke();
            throw new Error("forced revoke failure");
          },
        };
      },
    );
    let isolatedFactory: typeof createMemoryStorage;
    try {
      ({ createMemoryStorage: isolatedFactory } =
        await import("../../fixtures/memory-storage.js"));
    } finally {
      restoreProxyRevocable();
    }

    try {
      const store = isolatedFactory({
        cursorKey: new Uint8Array(32).fill(7),
      });
      store.migrate();
      let callbackCount = 0;
      expect(() =>
        store.withTransaction(() => {
          callbackCount += 1;
          try {
            store.getPlan(changePlanFixture.id);
          } catch {
            // Exercise transactionPoisoned cleanup as well.
          }
          return null;
        }),
      ).toThrow(/forced revoke failure/u);
      expect(() =>
        store.withTransaction((tx) => {
          callbackCount += 1;
          tx.savePlan(changePlanFixture);
          return null;
        }),
      ).toThrow(/forced revoke failure/u);
      expect(callbackCount).toBe(2);
      expect(store.getPlan(changePlanFixture.id)).toEqual(changePlanFixture);
    } finally {
      vi.resetModules();
    }
  });

  /* eslint-disable @typescript-eslint/unbound-method -- The test captures Map intrinsics to restore and invoke them safely. */
  test("does not expose private transaction maps through patched Map methods", () => {
    const originalMapSet = Map.prototype.set;
    const originalMapClear = Map.prototype.clear;
    const applyForTest = Reflect.apply;
    const store = openStore();
    let leakedPlanMap: Map<unknown, unknown> | undefined;
    let restoreMapSet: (() => void) | undefined;
    const rememberLeakedPlanMap = (value: Map<unknown, unknown>): void => {
      leakedPlanMap = value;
    };

    try {
      store.withTransaction((tx) => {
        restoreMapSet = replaceOwnPropertyForTest(
          Map.prototype,
          "set",
          function patchedMapSet(
            this: Map<unknown, unknown>,
            key: unknown,
            value: unknown,
          ): Map<unknown, unknown> {
            if (key === changePlanFixture.id) {
              rememberLeakedPlanMap(this);
            }
            return applyForTest(originalMapSet, this, [key, value]);
          },
        );
        tx.savePlan(changePlanFixture);
        return null;
      });
    } finally {
      restoreMapSet?.();
    }

    if (leakedPlanMap !== undefined) {
      applyForTest(originalMapClear, leakedPlanMap, []);
    }
    expect(Map.prototype.set).toBe(originalMapSet);
    expect(leakedPlanMap).toBeUndefined();
    expect(store.getPlan(changePlanFixture.id)).toEqual(changePlanFixture);
  });
  /* eslint-enable @typescript-eslint/unbound-method */

  test("starts unready and keeps migration/close idempotent without exposing a key", () => {
    const key = new Uint8Array(32).fill(5);
    const store = createMemoryStorage({ cursorKey: key });
    key.fill(9);
    expect(() => store.getSchemaVersion()).toThrow();
    expect(Reflect.ownKeys(store)).not.toContain("cursorKey");
    expect(Reflect.ownKeys(store)).not.toContain("codec");
    store.migrate();
    store.migrate();
    expect(store.getSchemaVersion()).toBe(1);
    store.close();
    store.close();
    expect(() => store.getSchemaVersion()).toThrow();
  });

  test("copies SharedArrayBuffer-backed cursor keys before migrate", () => {
    const keyByte = 0x45;
    const baseline = createMemoryStorage({
      cursorKey: new Uint8Array(32).fill(keyByte),
    });
    const sharedBuffer = new SharedArrayBuffer(32);
    const sharedKey = new Uint8Array(sharedBuffer);
    sharedKey.fill(keyByte);
    const isolated = createMemoryStorage({ cursorKey: sharedKey });
    sharedKey.fill(0x99);

    baseline.migrate();
    isolated.migrate();
    for (const store of [baseline, isolated]) {
      acquireSync(store);
      completeSnapshot(store, { batch: twoItemBatch() });
    }
    const query = {
      snapshotId: snapshotDraftFixture.id,
      filter: null,
      sort: [],
      pageSize: 1,
      cursor: null,
    } as const;
    expect(baseline.queryRepositories(query).nextCursor).toBe(
      isolated.queryRepositories(query).nextCursor,
    );
  });
});

describe("atomic snapshots, exact verification, and bounded queries", () => {
  test("publishes reordered exact sets and keeps aggregates independent of cursors", () => {
    const store = openStore();
    acquireSync(store);
    const batch = twoItemBatch();
    const verification = {
      stars: [...batch.stars].reverse(),
      lists: [...batch.lists].reverse(),
      memberships: [...batch.memberships].reverse(),
    };
    const snapshot = completeSnapshot(store, { batch, verification });
    expect(snapshot.status).toBe("complete");
    const first = store.queryRepositories({
      snapshotId: snapshot.id,
      filter: null,
      sort: [{ field: "stargazer_count", direction: "desc" }],
      pageSize: 1,
      cursor: null,
    });
    expect(first.total).toBe(2);
    expect(first.aggregates.languages).toEqual([
      { language: "TypeScript", count: 1 },
      { language: "__proto__", count: 1 },
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = store.queryRepositories({
      snapshotId: snapshot.id,
      filter: null,
      sort: [{ field: "stargazer_count", direction: "desc" }],
      pageSize: 1,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.total).toBe(first.total);
    expect(second.aggregates).toEqual(first.aggregates);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.items[0])).toBe(true);
  });

  test("rejects duplicate traversal identities and marks collection changes", () => {
    const store = openStore();
    acquireSync(store);
    const draft = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_duplicates",
    });
    store.createSnapshot({ draft, lease: SYNC_GUARD });
    expect(() =>
      store.appendSnapshotBatch({
        id: draft.id,
        batch: {
          repositories: [],
          stars: [
            snapshotBatchFixture.stars[0]!,
            snapshotBatchFixture.stars[0]!,
          ],
          lists: [],
          memberships: [],
        },
        lease: SYNC_GUARD,
      }),
    ).toThrow(/duplicate/iu);

    store.appendSnapshotBatch({
      id: draft.id,
      batch: snapshotBatchFixture,
      lease: SYNC_GUARD,
    });
    store.beginSnapshotVerification({
      id: draft.id,
      listCoverage: "complete",
      lease: SYNC_GUARD,
    });
    let duplicateFailure: unknown;
    try {
      store.appendSnapshotVerificationBatch({
        id: draft.id,
        batch: {
          stars: [
            snapshotBatchFixture.stars[0]!,
            snapshotBatchFixture.stars[0]!,
          ],
          lists: [],
          memberships: [],
        },
        lease: SYNC_GUARD,
      });
    } catch (error) {
      duplicateFailure = error;
    }
    expect(duplicateFailure).toBeInstanceOf(AppError);
    expect(duplicateFailure).toMatchObject({
      details: { reason: "collection_changed" },
    });
  });

  test("rolls back count and exact-set mismatches before publication", () => {
    const store = openStore();
    acquireSync(store);
    const draft = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_mismatch",
    });
    store.createSnapshot({ draft, lease: SYNC_GUARD });
    store.appendSnapshotBatch({
      id: draft.id,
      batch: snapshotBatchFixture,
      lease: SYNC_GUARD,
    });
    store.beginSnapshotVerification({
      id: draft.id,
      listCoverage: "complete",
      lease: SYNC_GUARD,
    });
    store.appendSnapshotVerificationBatch({
      id: draft.id,
      batch: {
        ...verificationBatch(snapshotBatchFixture),
        stars: [
          {
            ...snapshotBatchFixture.stars[0]!,
            starredAt: "2026-07-15T14:00:00.000Z",
          },
        ],
      },
      lease: SYNC_GUARD,
    });
    store.finishSnapshotVerification({ id: draft.id, lease: SYNC_GUARD });
    let mismatch: unknown;
    try {
      store.completeSnapshot({
        id: draft.id,
        completedAt: "2026-07-16T00:02:00.000Z",
        listCoverage: "complete",
        counts: { repositories: 1, stars: 1, lists: 1, memberships: 1 },
        warningCount: 0,
        sourceRateLimit: null,
        lease: SYNC_GUARD,
      });
    } catch (error) {
      mismatch = error;
    }
    expect(mismatch).toMatchObject({
      details: { reason: "collection_changed" },
    });
    expect(store.getCompleteSnapshot(draft.id)).toBeNull();

    const countDraft = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_counts",
    });
    store.createSnapshot({ draft: countDraft, lease: SYNC_GUARD });
    store.appendSnapshotBatch({
      id: countDraft.id,
      batch: snapshotBatchFixture,
      lease: SYNC_GUARD,
    });
    store.beginSnapshotVerification({
      id: countDraft.id,
      listCoverage: "complete",
      lease: SYNC_GUARD,
    });
    store.appendSnapshotVerificationBatch({
      id: countDraft.id,
      batch: verificationBatch(snapshotBatchFixture),
      lease: SYNC_GUARD,
    });
    store.finishSnapshotVerification({
      id: countDraft.id,
      lease: SYNC_GUARD,
    });
    expect(() =>
      store.completeSnapshot({
        id: countDraft.id,
        completedAt: "2026-07-16T00:02:00.000Z",
        listCoverage: "complete",
        counts: { repositories: 99, stars: 1, lists: 1, memberships: 1 },
        warningCount: 0,
        sourceRateLimit: null,
        lease: SYNC_GUARD,
      }),
    ).toThrow(/counts/iu);
    expect(store.getCompleteSnapshot(countDraft.id)).toBeNull();
    expect(
      store.completeSnapshot({
        id: countDraft.id,
        completedAt: "2026-07-16T00:02:00.000Z",
        listCoverage: "complete",
        counts: { repositories: 1, stars: 1, lists: 1, memberships: 1 },
        warningCount: 0,
        sourceRateLimit: null,
        lease: SYNC_GUARD,
      }).status,
    ).toBe("complete");
  });

  test("enforces exact coverage transitions and gates only List-dependent reads", () => {
    const store = openStore();
    acquireSync(store);
    const noLists = parseSnapshotBatch({
      repositories: snapshotBatchFixture.repositories,
      stars: snapshotBatchFixture.stars,
      lists: [],
      memberships: [],
    });
    const snapshot = completeSnapshot(store, {
      id: "snap_unavailable",
      batch: noLists,
      verification: verificationBatch(noLists),
      draftCoverage: "unavailable",
      finalCoverage: "unavailable",
    });
    expect(
      store.queryRepositories({
        snapshotId: snapshot.id,
        filter: null,
        sort: [],
        pageSize: 10,
        cursor: null,
      }).items,
    ).toHaveLength(1);
    expect(() =>
      store.queryRepositories({
        snapshotId: snapshot.id,
        filter: {
          field: "is_unclassified",
          op: "eq",
          value: true,
        },
        sort: [],
        pageSize: 10,
        cursor: null,
      }),
    ).toThrow(/List coverage/iu);
    expect(() =>
      store.queryLists({
        snapshotId: snapshot.id,
        pageSize: 10,
        cursor: null,
      }),
    ).toThrow(/List coverage/iu);

    const illegal = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_illegal_coverage",
    });
    store.createSnapshot({ draft: illegal, lease: SYNC_GUARD });
    expect(() =>
      store.beginSnapshotVerification({
        id: illegal.id,
        listCoverage: "unavailable",
        lease: SYNC_GUARD,
      }),
    ).toThrow(/transition/iu);
  });

  test("pins metadata, detaches writes, and returns frozen detached reads", () => {
    const store = openStore();
    acquireSync(store);
    const mutable = structuredClone(snapshotBatchFixture);
    completeSnapshot(store, {
      id: "snap_pinned",
      batch: mutable,
      verification: verificationBatch(mutable),
    });
    Reflect.set(mutable.repositories[0]!.repository, "stargazerCount", 999);
    const first = store.getSnapshotRepository(
      asSnapshotId("snap_pinned"),
      asRepositoryId("R_1"),
    );
    expect(first?.stargazerCount).toBe(10);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.topics)).toBe(true);

    const newer = parseSnapshotBatch({
      ...structuredClone(snapshotBatchFixture),
      repositories: [
        {
          repository: {
            ...repositoryInputFixture,
            stargazerCount: 50,
          },
          observedAt: "2026-07-17T00:00:00.000Z",
        },
      ],
    });
    completeSnapshot(store, { id: "snap_newer", batch: newer });
    expect(
      store.getSnapshotRepository(
        asSnapshotId("snap_pinned"),
        asRepositoryId("R_1"),
      )?.stargazerCount,
    ).toBe(10);
    expect(
      store.getRepositoryMetadata(asRepositoryId("R_1"))?.repository
        .stargazerCount,
    ).toBe(50);
    expect(
      store.getSnapshotRepository(
        asSnapshotId("snap_pinned"),
        asRepositoryId("R_1"),
      ),
    ).not.toBe(first);
  });

  test("selects equal-time current metadata by lexical version hash", () => {
    const observedAt = "2026-07-17T00:00:00.000Z";
    const repositories = [
      { ...repositoryInputFixture, stargazerCount: 111 },
      { ...repositoryInputFixture, stargazerCount: 222 },
    ] as const;
    const expected = [...repositories].sort((left, right) =>
      sha256Hex(canonicalJson(left)).localeCompare(
        sha256Hex(canonicalJson(right)),
      ),
    )[1]!;

    for (const [index, ordered] of [
      repositories,
      [...repositories].reverse(),
    ].entries()) {
      const store = openStore();
      acquireSync(store);
      for (const [snapshotIndex, repository] of ordered.entries()) {
        const batch = parseSnapshotBatch({
          ...structuredClone(snapshotBatchFixture),
          repositories: [{ repository, observedAt }],
        });
        completeSnapshot(store, {
          id: `snap_metadata_${index}_${snapshotIndex}`,
          batch,
        });
      }
      expect(
        store.getRepositoryMetadata(asRepositoryId("R_1"))?.repository
          .stargazerCount,
      ).toBe(expected.stargazerCount);
      expect(
        store.getSnapshotRepository(
          asSnapshotId(`snap_metadata_${index}_0`),
          asRepositoryId("R_1"),
        )?.stargazerCount,
      ).toBe(ordered[0].stargazerCount);
    }
  });

  test("detects exact-content collisions against historical metadata versions", () => {
    const versions = new Map<string, Repository>();
    const first = repositorySchema.parse({
      ...repositoryInputFixture,
      stargazerCount: 101,
    });
    const newerCurrent = repositorySchema.parse({
      ...repositoryInputFixture,
      stargazerCount: 202,
    });
    const colliding = repositorySchema.parse({
      ...repositoryInputFixture,
      stargazerCount: 303,
    });
    const historicalHash = "a".repeat(64);

    expect(
      registerRepositoryVersionForTest(versions, first, historicalHash),
    ).toEqual(first);
    registerRepositoryVersionForTest(versions, newerCurrent, "b".repeat(64));
    expect(() =>
      registerRepositoryVersionForTest(versions, colliding, historicalHash),
    ).toThrow(/collision/iu);
    expect(versions).toHaveLength(2);
    expect(
      registerRepositoryVersionForTest(versions, first, historicalHash),
    ).toEqual(first);
    expect(versions).toHaveLength(2);
  });

  test("enforces immutable bidirectional repository identity atomically", () => {
    const store = openStore();
    acquireSync(store);
    completeSnapshot(store, { id: "snap_identity_base" });
    const currentBefore = store.getRepositoryMetadata(asRepositoryId("R_1"));
    const draft = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_identity_next",
    });
    store.createSnapshot({ draft, lease: SYNC_GUARD });

    const changedDatabaseId = parseSnapshotBatch({
      repositories: [
        {
          repository: {
            ...repositoryInputFixture,
            repositoryDatabaseId: "999",
            stargazerCount: 999,
          },
          observedAt: "2026-07-17T00:00:00.000Z",
        },
      ],
      stars: snapshotBatchFixture.stars,
      lists: [],
      memberships: [],
    });
    expect(() =>
      store.appendSnapshotBatch({
        id: draft.id,
        batch: changedDatabaseId,
        lease: SYNC_GUARD,
      }),
    ).toThrow(/database|identity|immutable/iu);

    const reusedDatabaseId = parseSnapshotBatch({
      repositories: [
        {
          repository: {
            ...repositoryInputFixture,
            repositoryId: "R_2",
            name: "Other",
            fullName: "OpenAI/Other",
            url: "https://github.com/OpenAI/Other",
          },
          observedAt: "2026-07-17T00:00:00.000Z",
        },
      ],
      stars: [
        {
          repositoryId: "R_2",
          starredAt: "2026-07-16T12:00:00.000Z",
        },
      ],
      lists: [],
      memberships: [],
    });
    expect(() =>
      store.appendSnapshotBatch({
        id: draft.id,
        batch: reusedDatabaseId,
        lease: SYNC_GUARD,
      }),
    ).toThrow(/database|identity|immutable/iu);
    expect(store.getRepositoryMetadata(asRepositoryId("R_1"))).toEqual(
      currentBefore,
    );
    expect(store.getRepositoryMetadata(asRepositoryId("R_2"))).toBeNull();

    const valid = parseSnapshotBatch({
      repositories: [
        {
          repository: {
            ...repositoryInputFixture,
            stargazerCount: 333,
          },
          observedAt: "2026-07-17T00:00:00.000Z",
        },
        {
          repository: {
            ...repositoryInputFixture,
            repositoryId: "R_2",
            repositoryDatabaseId: "43",
            name: "Other",
            fullName: "OpenAI/Other",
            url: "https://github.com/OpenAI/Other",
          },
          observedAt: "2026-07-17T00:00:00.000Z",
        },
      ],
      stars: [
        snapshotBatchFixture.stars[0],
        {
          repositoryId: "R_2",
          starredAt: "2026-07-16T12:00:00.000Z",
        },
      ],
      lists: [],
      memberships: [],
    });
    store.appendSnapshotBatch({
      id: draft.id,
      batch: valid,
      lease: SYNC_GUARD,
    });
    store.beginSnapshotVerification({
      id: draft.id,
      listCoverage: "complete",
      lease: SYNC_GUARD,
    });
    store.appendSnapshotVerificationBatch({
      id: draft.id,
      batch: verificationBatch(valid),
      lease: SYNC_GUARD,
    });
    store.finishSnapshotVerification({ id: draft.id, lease: SYNC_GUARD });
    store.completeSnapshot({
      id: draft.id,
      completedAt: "2026-07-17T00:01:00.000Z",
      listCoverage: "complete",
      counts: { repositories: 2, stars: 2, lists: 0, memberships: 0 },
      warningCount: 0,
      sourceRateLimit: null,
      lease: SYNC_GUARD,
    });
    expect(
      store.getRepositoryMetadata(asRepositoryId("R_1"))?.repository
        .stargazerCount,
    ).toBe(333);
    expect(
      store.getRepositoryMetadata(asRepositoryId("R_2"))?.repository
        .repositoryDatabaseId,
    ).toBe("43");
    expect(
      store.getSnapshotRepository(
        asSnapshotId("snap_identity_base"),
        asRepositoryId("R_1"),
      )?.stargazerCount,
    ).toBe(10);

    const sameVersionLater = parseSnapshotBatch({
      repositories: [
        {
          repository: valid.repositories[0]!.repository,
          observedAt: "2026-07-18T00:00:00.000Z",
        },
      ],
      stars: [valid.stars[0]!],
      lists: [],
      memberships: [],
    });
    completeSnapshot(store, {
      id: "snap_identity_same_version_later",
      batch: sameVersionLater,
    });
    expect(store.getRepositoryMetadata(asRepositoryId("R_1"))?.observedAt).toBe(
      "2026-07-18T00:00:00.000Z",
    );
  });

  test("authenticates List and both membership pagination directions", () => {
    const store = openStore();
    acquireSync(store);
    const snapshot = completeSnapshot(store, { batch: twoItemBatch() });
    const firstListPage = store.queryLists({
      snapshotId: snapshot.id,
      pageSize: 1,
      cursor: null,
    });
    expect(firstListPage.items[0]).not.toHaveProperty("repositoryIds");
    expect(firstListPage.items[0]?.repositoryCount).toBeGreaterThan(0);
    expect(
      store.queryLists({
        snapshotId: snapshot.id,
        pageSize: 1,
        cursor: firstListPage.nextCursor,
      }).items,
    ).toHaveLength(1);

    const byList = store.queryListMemberships({
      snapshotId: snapshot.id,
      selector: { kind: "list", listId: asUserListId("UL_1") },
      pageSize: 1,
      cursor: null,
    });
    expect("repositoryIds" in byList && byList.repositoryIds).toHaveLength(1);
    const byListNext = store.queryListMemberships({
      snapshotId: snapshot.id,
      selector: { kind: "list", listId: asUserListId("UL_1") },
      pageSize: 1,
      cursor: byList.nextCursor,
    });
    expect(
      "repositoryIds" in byListNext && byListNext.repositoryIds,
    ).toHaveLength(1);

    const byRepository = store.queryListMemberships({
      snapshotId: snapshot.id,
      selector: {
        kind: "repository",
        repositoryId: asRepositoryId("R_1"),
      },
      pageSize: 1,
      cursor: null,
    });
    expect("listIds" in byRepository && byRepository.listIds).toHaveLength(1);
    expect(() =>
      store.queryListMemberships({
        snapshotId: snapshot.id,
        selector: {
          kind: "repository",
          repositoryId: asRepositoryId("R_1"),
        },
        pageSize: 1,
        cursor: byList.nextCursor,
      }),
    ).toThrow(/selection|resource|membership/iu);
    const tampered = `${byList.nextCursor?.slice(0, -1)}A`;
    expect(() =>
      store.queryListMemberships({
        snapshotId: snapshot.id,
        selector: { kind: "list", listId: asUserListId("UL_1") },
        pageSize: 1,
        cursor: tampered,
      }),
    ).toThrow();
  });

  test("keeps 101 memberships out of public repository rows and pages them only through membership queries", () => {
    const store = openStore();
    acquireSync(store);
    const draft = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_many_memberships",
    });
    const lists = Array.from({ length: 101 }, (_, index) => ({
      listId: asUserListId(`UL_many_${String(index).padStart(3, "0")}`),
      name: `List ${String(index).padStart(3, "0")}`,
      slug: `list-${String(index).padStart(3, "0")}`,
      description: null,
      isPrivate: false,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      lastAddedAt: null,
    }));
    const memberships = lists.map((list) => ({
      listId: list.listId,
      repositoryId: asRepositoryId("R_1"),
    }));
    store.createSnapshot({ draft, lease: SYNC_GUARD });
    store.appendSnapshotBatch({
      id: draft.id,
      batch: {
        repositories: snapshotBatchFixture.repositories,
        stars: snapshotBatchFixture.stars,
        lists: [],
        memberships: [],
      },
      lease: SYNC_GUARD,
    });
    for (const [listPage, membershipPage] of [
      [lists.slice(0, 100), memberships.slice(0, 100)],
      [lists.slice(100), memberships.slice(100)],
    ] as const) {
      store.appendSnapshotBatch({
        id: draft.id,
        batch: {
          repositories: [],
          stars: [],
          lists: listPage,
          memberships: membershipPage,
        },
        lease: SYNC_GUARD,
      });
    }
    store.beginSnapshotVerification({
      id: draft.id,
      listCoverage: "complete",
      lease: SYNC_GUARD,
    });
    store.appendSnapshotVerificationBatch({
      id: draft.id,
      batch: {
        stars: snapshotBatchFixture.stars,
        lists: [],
        memberships: [],
      },
      lease: SYNC_GUARD,
    });
    for (const [listPage, membershipPage] of [
      [lists.slice(0, 100), memberships.slice(0, 100)],
      [lists.slice(100), memberships.slice(100)],
    ] as const) {
      store.appendSnapshotVerificationBatch({
        id: draft.id,
        batch: {
          stars: [],
          lists: listPage,
          memberships: membershipPage,
        },
        lease: SYNC_GUARD,
      });
    }
    store.finishSnapshotVerification({ id: draft.id, lease: SYNC_GUARD });
    store.completeSnapshot({
      id: draft.id,
      completedAt: "2026-07-16T00:02:00.000Z",
      listCoverage: "complete",
      counts: {
        repositories: 1,
        stars: 1,
        lists: 101,
        memberships: 101,
      },
      warningCount: 0,
      sourceRateLimit: null,
      lease: SYNC_GUARD,
    });

    expect(
      store.getSnapshotRepository(draft.id, asRepositoryId("R_1")),
    ).not.toHaveProperty("listIds");
    expect(
      store.queryRepositories({
        snapshotId: draft.id,
        filter: null,
        sort: [],
        pageSize: 1,
        cursor: null,
      }).items[0],
    ).not.toHaveProperty("listIds");

    const first = store.queryListMemberships({
      snapshotId: draft.id,
      selector: {
        kind: "repository",
        repositoryId: asRepositoryId("R_1"),
      },
      pageSize: 100,
      cursor: null,
    });
    expect("listIds" in first && first.listIds).toHaveLength(100);
    expect(first.total).toBe(101);
    expect(first.nextCursor).not.toBeNull();
    const second = store.queryListMemberships({
      snapshotId: draft.id,
      selector: {
        kind: "repository",
        repositoryId: asRepositoryId("R_1"),
      },
      pageSize: 100,
      cursor: first.nextCursor,
    });
    expect("listIds" in second && second.listIds).toHaveLength(1);
    expect(second.total).toBe(101);
    expect(second.nextCursor).toBeNull();
  });
});

describe("plans, runs, attempts, reconciliation, and audit bounds", () => {
  test("enforces one plan/run, immutable operation identity, and idempotency", () => {
    const store = openStore();
    prepareRun(store);
    expect(() =>
      store.createRun({
        run: parseChangeRun({ ...changeRunFixture, id: "run_other" }),
        lease: APPLY_GUARD,
      }),
    ).toThrow(/one run/iu);
    expect(() =>
      store.createRunOperation({
        operation: parseRunOperation({
          ...pendingOperationFixture,
          before: { starred: false },
        }),
        lease: APPLY_GUARD,
      }),
    ).toThrow(/plan|immutable/iu);

    store.savePlan(changePlanFixture);
    store.createRun({ run: changeRunFixture, lease: APPLY_GUARD });
    store.createRunOperation({
      operation: pendingOperationFixture,
      lease: APPLY_GUARD,
    });
    store.startRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      startedAt: "2026-07-16T02:02:00.000Z",
      lease: APPLY_GUARD,
    });
    store.createRunOperation({
      operation: pendingOperationFixture,
      lease: APPLY_GUARD,
    });
    expect(store.getRun(changeRunFixture.id)?.state).toBe("running");
    expect(
      store.getRunOperation({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
      })?.status,
    ).toBe("running");
  });

  test("preserves attempts and append-only reconciliation across retries", () => {
    const store = openStore();
    prepareRun(store);
    store.startRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      startedAt: "2026-07-16T02:02:00.000Z",
      lease: APPLY_GUARD,
    });
    store.finishRunOperation({
      phase: "after_dispatch",
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      status: "failed",
      reconciliation: "confirmed_not_applied",
      externalRequestId: "req_1",
      after: { starred: true },
      error: retryableError(),
      finishedAt: "2026-07-16T02:03:00.000Z",
      lease: APPLY_GUARD,
    });
    expect(
      store.getRunOperationAttempt({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        attempt: 1,
      })?.status,
    ).toBe("failed");
    store.retryRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      maxAttempts: 2,
      lease: APPLY_GUARD,
    });
    store.startRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      startedAt: "2026-07-16T02:04:00.000Z",
      lease: APPLY_GUARD,
    });
    store.finishRunOperation({
      phase: "after_dispatch",
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      status: "unresolved",
      reconciliation: "unknown",
      externalRequestId: null,
      after: null,
      error: unknownError(),
      finishedAt: "2026-07-16T02:05:00.000Z",
      lease: APPLY_GUARD,
    });
    store.reconcileRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      status: "unresolved",
      reconciliation: "unknown",
      after: null,
      error: unknownError(),
      observedAt: "2026-07-16T02:06:00.000Z",
      lease: APPLY_GUARD,
    });
    store.reconcileRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      status: "unresolved",
      reconciliation: "unknown",
      after: null,
      error: unknownError(),
      observedAt: "2026-07-16T02:07:00.000Z",
      lease: APPLY_GUARD,
    });
    store.reconcileRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      status: "failed",
      reconciliation: "confirmed_not_applied",
      after: { starred: true },
      error: retryableError(),
      observedAt: "2026-07-16T02:08:00.000Z",
      lease: APPLY_GUARD,
    });
    expect(() =>
      store.retryRunOperation({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        maxAttempts: 2,
        lease: APPLY_GUARD,
      }),
    ).toThrow(/eligible/iu);
    expect(
      store.retryRunOperation({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        maxAttempts: 3,
        lease: APPLY_GUARD,
      }).status,
    ).toBe("pending");
    const attempts = store.listRunOperationAttemptsPage({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      afterAttempt: null,
      pageSize: 1,
    });
    expect(attempts.total).toBe(2);
    expect(attempts.nextAttempt).toBe(1);
    expect(
      store.listRunOperationAttemptsPage({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        afterAttempt: attempts.nextAttempt,
        pageSize: 10,
      }).items,
    ).toHaveLength(1);
    const reconciliations = store.listRunOperationReconciliationsPage({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      afterEventSequence: null,
      pageSize: 10,
    });
    expect(reconciliations.items.map(({ status }) => status)).toEqual([
      "unresolved",
      "unresolved",
      "failed",
    ]);
    expect(
      reconciliations.items.map(({ eventSequence }) => eventSequence),
    ).toEqual([1, 2, 3]);
    expect(
      store.getRunOperationAttempt({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        attempt: 2,
      })?.finishedAt,
    ).toBe("2026-07-16T02:05:00.000Z");
  });

  test("finishes before dispatch without creating an attempt and validates pages", () => {
    const store = openStore();
    prepareRun(store);
    const result = store.finishRunOperation({
      phase: "before_dispatch",
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      status: "failed",
      reconciliation: "confirmed_not_applied",
      error: retryableError(),
      finishedAt: "2026-07-16T02:02:00.000Z",
      lease: APPLY_GUARD,
    });
    expect(result.attempts).toBe(0);
    expect(
      store.listRunOperationAttemptsPage({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        afterAttempt: null,
        pageSize: 10,
      }).total,
    ).toBe(0);
    expect(() =>
      store.listRunOperationsPage({
        runId: changeRunFixture.id,
        afterSequence: 1,
        pageSize: 10,
      }),
    ).toThrow(/beyond/iu);
    expect(() =>
      store.listRunOperationsPage({
        runId: changeRunFixture.id,
        afterSequence: null,
        pageSize: 101,
      }),
    ).toThrow(/page size/iu);
  });

  test("rejects an unknown finish phase without finalizing the dispatch attempt", () => {
    const store = openStore();
    prepareRun(store);
    store.startRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      startedAt: "2026-07-16T02:02:00.000Z",
      lease: APPLY_GUARD,
    });
    const finishUnknown = (input: unknown): unknown =>
      (store.finishRunOperation as unknown as (rawInput: unknown) => unknown)(
        input,
      );
    let caught: unknown;
    try {
      finishUnknown({
        phase: "after_dispach",
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        status: "succeeded",
        reconciliation: "not_required",
        externalRequestId: null,
        after: { starred: false },
        error: null,
        finishedAt: "2026-07-16T02:03:00.000Z",
        lease: APPLY_GUARD,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(
      store.getRunOperation({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
      })?.status,
    ).toBe("running");
    expect(
      store.getRunOperationAttempt({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        attempt: 1,
      })?.status,
    ).toBe("running");
  });

  test("allows a retried pending operation to skip without a new dispatch attempt", () => {
    const store = openStore();
    prepareRun(store);
    store.startRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      startedAt: "2026-07-16T02:02:00.000Z",
      lease: APPLY_GUARD,
    });
    store.finishRunOperation({
      phase: "after_dispatch",
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      status: "failed",
      reconciliation: "confirmed_not_applied",
      externalRequestId: null,
      after: { starred: true },
      error: retryableError(),
      finishedAt: "2026-07-16T02:03:00.000Z",
      lease: APPLY_GUARD,
    });
    store.retryRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      maxAttempts: 2,
      lease: APPLY_GUARD,
    });
    const skipped = store.finishRunOperation({
      phase: "before_dispatch",
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      status: "skipped",
      reconciliation: "not_required",
      error: null,
      finishedAt: "2026-07-16T02:04:00.000Z",
      lease: APPLY_GUARD,
    });
    expect(skipped).toMatchObject({
      status: "skipped",
      reconciliation: "not_required",
      attempts: 1,
      startedAt: null,
      externalRequestId: null,
      after: null,
      error: null,
    });
    expect(
      store.listRunOperationAttemptsPage({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        afterAttempt: null,
        pageSize: 10,
      }),
    ).toMatchObject({ total: 1, nextAttempt: null });
  });

  test("validates all requested CAS edges before reading and requires fresh finish times", () => {
    const store = openStore();
    store.acquireLease({
      name: APPLY_GUARD.name,
      ownerId: APPLY_GUARD.ownerId,
      now: "2026-07-16T02:00:00.000Z",
      expiresAt: "2026-07-16T02:10:00.000Z",
    });
    expect(() =>
      store.compareAndSetPlanState({
        planId: asPlanId("missing"),
        expected: ["applied"],
        next: "applying",
      }),
    ).toThrow(/transition/iu);
    store.savePlan(changePlanFixture);
    store.compareAndSetPlanState({
      planId: changePlanFixture.id,
      expected: ["ready"],
      next: "applying",
    });
    store.createRun({ run: changeRunFixture, lease: APPLY_GUARD });
    store.compareAndSetRunState({
      runId: changeRunFixture.id,
      expected: ["pending"],
      next: "running",
      finishedAt: null,
      lease: APPLY_GUARD,
    });
    expect(() =>
      store.compareAndSetRunState({
        runId: changeRunFixture.id,
        expected: ["running"],
        next: "partial",
        finishedAt: "2026-07-16T02:00:30.000Z",
        lease: APPLY_GUARD,
      }),
    ).toThrow(/finishedAt/iu);
    expect(
      store.compareAndSetRunState({
        runId: changeRunFixture.id,
        expected: ["running"],
        next: "partial",
        finishedAt: "2026-07-16T02:02:00.000Z",
        lease: APPLY_GUARD,
      }).state,
    ).toBe("partial");
  });
});

describe("leases, targeted takeover recovery, and bounded summaries", () => {
  test("rejects active same-owner reacquire and enforces renew/takeover ownership", () => {
    const store = openStore();
    const first = store.acquireLease({
      name: "sync",
      ownerId: "p1",
      now: "2026-07-16T00:00:00.000Z",
      expiresAt: "2026-07-16T00:05:00.000Z",
    });
    expect(first?.ownerId).toBe("p1");
    expect(
      store.acquireLease({
        name: "sync",
        ownerId: "p1",
        now: "2026-07-16T00:01:00.000Z",
        expiresAt: "2026-07-16T00:06:00.000Z",
      }),
    ).toBeNull();
    expect(() =>
      store.renewLease({
        name: "sync",
        ownerId: "p2",
        now: "2026-07-16T00:01:00.000Z",
        expiresAt: "2026-07-16T00:06:00.000Z",
      }),
    ).toThrow(/owner|renew/iu);
    expect(
      store.renewLease({
        name: "sync",
        ownerId: "p1",
        now: "2026-07-16T00:01:00.000Z",
        expiresAt: "2026-07-16T00:06:00.000Z",
      }).acquiredAt,
    ).toBe(first?.acquiredAt);
    expect(() =>
      store.renewLease({
        name: "sync",
        ownerId: "p1",
        now: "2026-07-16T00:00:30.000Z",
        expiresAt: "2026-07-16T00:07:00.000Z",
      }),
    ).toThrow(/backward|time|renew/iu);
    expect(
      store.acquireLease({
        name: "sync",
        ownerId: "p2",
        now: "2026-07-16T00:07:00.000Z",
        expiresAt: "2026-07-16T00:10:00.000Z",
      })?.ownerId,
    ).toBe("p2");
    expect(() => store.releaseLease({ name: "sync", ownerId: "p1" })).toThrow(
      /owner/iu,
    );
  });

  test("requires the same account-scoped lease name for targeted snapshot recovery", () => {
    const store = openStore();
    store.acquireLease({
      name: "sync:U_1",
      ownerId: "old",
      now: "2026-07-16T00:00:00.000Z",
      expiresAt: "2026-07-16T00:05:00.000Z",
    });
    const oldGuard = {
      name: "sync:U_1",
      ownerId: "old",
      now: "2026-07-16T00:01:00.000Z",
    } as const;
    const draft = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_abandoned",
    });
    store.createSnapshot({ draft, lease: oldGuard });
    expect(
      store.recoverIncompleteSnapshots("2026-07-16T00:03:00.000Z"),
    ).toEqual([]);

    store.acquireLease({
      name: "unrelated",
      ownerId: "other",
      now: "2026-07-16T00:06:00.000Z",
      expiresAt: "2026-07-16T00:10:00.000Z",
    });
    expect(
      store.recoverAbandonedSnapshots({
        binding: accountBindingFixture,
        lease: {
          name: "unrelated",
          ownerId: "other",
          now: "2026-07-16T00:06:30.000Z",
        },
      }),
    ).toEqual([]);
    store.acquireLease({
      name: "sync:U_1",
      ownerId: "new",
      now: "2026-07-16T00:06:00.000Z",
      expiresAt: "2026-07-16T00:10:00.000Z",
    });
    expect(
      store.recoverAbandonedSnapshots({
        binding: accountBindingFixture,
        lease: {
          name: "sync:U_1",
          ownerId: "new",
          now: "2026-07-16T00:06:30.000Z",
        },
      }),
    ).toEqual([draft.id]);
    expect(
      store.recoverIncompleteSnapshots("2026-07-16T00:07:00.000Z"),
    ).toEqual([]);
  });

  test("rolls back every global snapshot recovery when a later candidate is invalid", () => {
    const store = openStore();
    store.acquireLease({
      name: "sync:atomic",
      ownerId: "old",
      now: "2026-07-16T00:00:00.000Z",
      expiresAt: "2026-07-16T00:10:00.000Z",
    });
    const guard = {
      name: "sync:atomic",
      ownerId: "old",
      now: "2026-07-16T00:01:00.000Z",
    } as const;
    const early = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_atomic_early",
      startedAt: "2026-07-16T00:00:00.000Z",
    });
    const future = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_atomic_future",
      startedAt: "2026-07-16T00:20:00.000Z",
    });
    store.createSnapshot({ draft: early, lease: guard });
    store.createSnapshot({ draft: future, lease: guard });

    expect(() =>
      store.recoverIncompleteSnapshots("2026-07-16T00:15:00.000Z"),
    ).toThrow(/precede|timestamp/iu);
    const recovered = store.recoverIncompleteSnapshots(
      "2026-07-16T00:21:00.000Z",
    );
    expect(Array.isArray(recovered)).toBe(true);
    expect(Object.getPrototypeOf(recovered)).toBe(Array.prototype);
    expect(Object.isFrozen(recovered)).toBe(true);
    expect(recovered.map((id) => id)).toEqual([early.id, future.id]);
  });

  test("recovers pending/running audit state once and rebinds a resumed run", () => {
    const store = openStore();
    prepareRun(store);
    store.startRunOperation({
      runId: changeRunFixture.id,
      operationId: pendingOperationFixture.operationId,
      startedAt: "2026-07-16T02:02:00.000Z",
      lease: APPLY_GUARD,
    });
    expect(store.recoverInterruptedRuns("2026-07-16T02:03:00.000Z")).toEqual(
      [],
    );
    store.acquireLease({
      name: APPLY_GUARD.name,
      ownerId: "new-owner",
      now: "2026-07-16T02:11:00.000Z",
      expiresAt: "2026-07-16T02:20:00.000Z",
    });
    const resumed = {
      name: APPLY_GUARD.name,
      ownerId: "new-owner",
      now: "2026-07-16T02:12:00.000Z",
    } as const;
    expect(
      store.recoverAbandonedRuns({
        binding: accountBindingFixture,
        lease: resumed,
      }),
    ).toEqual([changeRunFixture.id]);
    expect(
      store.getRunOperation({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
      })?.status,
    ).toBe("unresolved");
    expect(
      store.getRunOperationAttempt({
        runId: changeRunFixture.id,
        operationId: pendingOperationFixture.operationId,
        attempt: 1,
      })?.status,
    ).toBe("unresolved");
    expect(store.recoverInterruptedRuns("2026-07-16T02:13:00.000Z")).toEqual(
      [],
    );
    expect(
      store.compareAndSetRunState({
        runId: changeRunFixture.id,
        expected: ["partial"],
        next: "running",
        finishedAt: null,
        lease: resumed,
      }).state,
    ).toBe("running");
  });

  test("rolls back targeted run recovery and classifies pending rows before dispatch", () => {
    const store = openStore();
    const leaseName = "apply:atomic";
    store.acquireLease({
      name: leaseName,
      ownerId: "old",
      now: "2026-07-16T02:00:00.000Z",
      expiresAt: "2026-07-16T02:10:00.000Z",
    });
    const oldGuard = {
      name: leaseName,
      ownerId: "old",
      now: "2026-07-16T02:01:00.000Z",
    } as const;

    const createCandidate = (
      suffix: "early" | "future",
      startedAt: string,
      withOperation: boolean,
    ) => {
      const plan = parseChangePlan({
        ...changePlanFixture,
        id: `plan_atomic_${suffix}`,
      });
      const run = parseChangeRun({
        ...changeRunFixture,
        id: `run_atomic_${suffix}`,
        planId: plan.id,
        startedAt,
      });
      store.savePlan(plan);
      store.compareAndSetPlanState({
        planId: plan.id,
        expected: ["ready"],
        next: "applying",
      });
      store.createRun({ run, lease: oldGuard });
      store.compareAndSetRunState({
        runId: run.id,
        expected: ["pending"],
        next: "running",
        finishedAt: null,
        lease: oldGuard,
      });
      if (withOperation) {
        store.createRunOperation({
          operation: parseRunOperation({
            ...pendingOperationFixture,
            runId: run.id,
          }),
          lease: oldGuard,
        });
      }
      return run;
    };

    const early = createCandidate("early", "2026-07-16T02:00:00.000Z", true);
    const future = createCandidate("future", "2026-07-16T03:00:00.000Z", false);
    store.acquireLease({
      name: leaseName,
      ownerId: "new",
      now: "2026-07-16T02:11:00.000Z",
      expiresAt: "2026-07-16T04:00:00.000Z",
    });
    expect(() =>
      store.recoverAbandonedRuns({
        binding: accountBindingFixture,
        lease: {
          name: leaseName,
          ownerId: "new",
          now: "2026-07-16T02:12:00.000Z",
        },
      }),
    ).toThrow(/precede|finishedAt/iu);

    expect(
      store.recoverAbandonedRuns({
        binding: accountBindingFixture,
        lease: {
          name: leaseName,
          ownerId: "new",
          now: "2026-07-16T03:01:00.000Z",
        },
      }),
    ).toEqual([early.id, future.id]);
    expect(
      store.getRunOperation({
        runId: early.id,
        operationId: pendingOperationFixture.operationId,
      }),
    ).toMatchObject({
      status: "failed",
      reconciliation: "confirmed_not_applied",
      attempts: 0,
      startedAt: null,
      externalRequestId: null,
      error: {
        code: "INTERNAL_ERROR",
        retryable: true,
      },
    });
  });

  test("bounds incomplete summaries while reporting full totals and status counts", () => {
    const store = openStore();
    store.acquireLease({
      name: APPLY_GUARD.name,
      ownerId: APPLY_GUARD.ownerId,
      now: "2026-07-16T02:00:00.000Z",
      expiresAt: "2026-07-16T02:10:00.000Z",
    });
    for (let index = 1; index <= 2; index += 1) {
      const plan = parseChangePlan({
        ...changePlanFixture,
        id: `plan_${index}`,
      });
      const run = parseChangeRun({
        ...changeRunFixture,
        id: `run_${index}`,
        planId: plan.id,
      });
      store.savePlan(plan);
      store.compareAndSetPlanState({
        planId: plan.id,
        expected: ["ready"],
        next: "applying",
      });
      store.createRun({ run, lease: APPLY_GUARD });
    }
    const result = store.getIncompleteRunSummaries({
      binding: accountBindingFixture,
      limit: 1,
    });
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.items[0]?.counts).toEqual({
      pending: 0,
      running: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      unresolved: 0,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe("recovery isolation from mutable realm hooks", () => {
  test("captures structuredClone so a later snapshot failure rolls back every staged recovery", () => {
    const originalStructuredClone = globalThis.structuredClone;
    const store = openStore();
    store.acquireLease({
      name: "sync:clone-atomic",
      ownerId: "old",
      now: "2026-07-16T00:00:00.000Z",
      expiresAt: "2026-07-16T00:10:00.000Z",
    });
    const guard = {
      name: "sync:clone-atomic",
      ownerId: "old",
      now: "2026-07-16T00:01:00.000Z",
    } as const;
    const early = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_clone_atomic_early",
      startedAt: "2026-07-16T00:00:00.000Z",
    });
    const future = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_clone_atomic_future",
      startedAt: "2026-07-16T00:20:00.000Z",
    });
    store.createSnapshot({ draft: early, lease: guard });
    store.createSnapshot({ draft: future, lease: guard });
    const restoreStructuredClone = replaceOwnPropertyForTest(
      globalThis,
      "structuredClone",
      <T>(value: T): T => value,
    );

    try {
      expect(() =>
        store.recoverIncompleteSnapshots("2026-07-16T00:15:00.000Z"),
      ).toThrow(/precede|timestamp/iu);
    } finally {
      restoreStructuredClone();
    }

    expect(globalThis.structuredClone).toBe(originalStructuredClone);
    expect(
      store.recoverIncompleteSnapshots("2026-07-16T00:21:00.000Z"),
    ).toEqual([early.id, future.id]);
  });

  /* eslint-disable @typescript-eslint/unbound-method -- The test records, damages, and restores receiver-sensitive collection intrinsics through captured Reflect.apply. */
  test("does not leak active recovery state through patched Map, Set, Array, or Object hooks", () => {
    const applyForTest = Reflect.apply;
    const arrayIsArrayForTest = Array.isArray;
    const originals = {
      mapClear: Map.prototype.clear,
      mapGet: Map.prototype.get,
      mapSet: Map.prototype.set,
      mapValues: Map.prototype.values,
      setAdd: Set.prototype.add,
      setClear: Set.prototype.clear,
      setHas: Set.prototype.has,
      arrayFilter: Array.prototype.filter,
      objectFreeze: Object.freeze,
    };
    const observedMaps: Map<unknown, unknown>[] = [];
    const observedSets: Set<unknown>[] = [];
    const restorers: Array<() => void> = [];
    let privateArrayReceivers = 0;
    let privateObjectArguments = 0;

    function rememberMap(receiver: Map<unknown, unknown>): void {
      for (let index = 0; index < observedMaps.length; index += 1) {
        if (observedMaps[index] === receiver) return;
      }
      observedMaps[observedMaps.length] = receiver;
    }

    function rememberSet(receiver: Set<unknown>): void {
      for (let index = 0; index < observedSets.length; index += 1) {
        if (observedSets[index] === receiver) return;
      }
      observedSets[observedSets.length] = receiver;
    }

    function isPrivateRecord(value: unknown): boolean {
      if (value === null || typeof value !== "object") return false;
      const snapshot = getOwnPropertyDescriptorForTest(value, "snapshot");
      const run = getOwnPropertyDescriptorForTest(value, "run");
      const leaseName = getOwnPropertyDescriptorForTest(value, "leaseName");
      const leaseOwnerId = getOwnPropertyDescriptorForTest(
        value,
        "leaseOwnerId",
      );
      return (
        (snapshot !== undefined || run !== undefined) &&
        leaseName !== undefined &&
        leaseOwnerId !== undefined
      );
    }

    function observeArray(receiver: unknown): void {
      if (!arrayIsArrayForTest(receiver)) return;
      for (let index = 0; index < receiver.length; index += 1) {
        const descriptor = getOwnPropertyDescriptorForTest(
          receiver,
          String(index),
        );
        if (
          descriptor !== undefined &&
          "value" in descriptor &&
          isPrivateRecord(descriptor.value)
        ) {
          privateArrayReceivers += 1;
          return;
        }
      }
    }

    function patch(
      target: object,
      property: PropertyKey,
      value: unknown,
    ): void {
      restorers[restorers.length] = replaceOwnPropertyForTest(
        target,
        property,
        value,
      );
    }

    const store = openStore();
    const leaseName = "sync:receiver-isolation";
    store.acquireLease({
      name: leaseName,
      ownerId: "live-owner",
      now: "2026-07-16T00:00:00.000Z",
      expiresAt: "2026-07-16T00:10:00.000Z",
    });
    const guard = {
      name: leaseName,
      ownerId: "live-owner",
      now: "2026-07-16T00:05:00.000Z",
    } as const;
    const draft = parseSnapshotDraft({
      ...snapshotDraftFixture,
      id: "snap_receiver_isolation",
    });
    store.createSnapshot({
      draft,
      lease: {
        ...guard,
        now: "2026-07-16T00:01:00.000Z",
      },
    });

    let activeRecovery: readonly string[] | undefined;
    let recoveryError: unknown;
    try {
      patch(
        Map.prototype,
        "get",
        function patchedMapGet(
          this: Map<unknown, unknown>,
          key: unknown,
        ): unknown {
          rememberMap(this);
          return applyForTest(originals.mapGet, this, [key]) as unknown;
        },
      );
      patch(
        Map.prototype,
        "values",
        function patchedMapValues(
          this: Map<unknown, unknown>,
        ): IterableIterator<unknown> {
          rememberMap(this);
          return applyForTest(
            originals.mapValues,
            this,
            [],
          ) as IterableIterator<unknown>;
        },
      );
      patch(
        Set.prototype,
        "has",
        function patchedSetHas(this: Set<unknown>, value: unknown): boolean {
          rememberSet(this);
          return applyForTest(originals.setHas, this, [value]);
        },
      );
      patch(
        Array.prototype,
        "filter",
        function patchedArrayFilter(
          this: unknown,
          ...args: unknown[]
        ): unknown {
          observeArray(this);
          return applyForTest(originals.arrayFilter, this, args) as unknown;
        },
      );
      patch(Object, "freeze", <T>(value: T): Readonly<T> => {
        if (
          isPrivateRecord(value) ||
          (arrayIsArrayForTest(value) &&
            getOwnPropertyDescriptorForTest(value, "length")?.value === 0)
        ) {
          privateObjectArguments += 1;
        }
        return applyForTest(originals.objectFreeze, Object, [
          value,
        ]) as Readonly<T>;
      });

      try {
        activeRecovery = store.recoverAbandonedSnapshots({
          binding: accountBindingFixture,
          lease: guard,
        });
      } catch (error) {
        recoveryError = error;
      }
    } finally {
      for (let index = restorers.length - 1; index >= 0; index -= 1) {
        restorers[index]?.();
      }
    }

    const mapBackups = observedMaps.map((receiver) => ({
      receiver,
      entries: [...receiver.entries()],
    }));
    const setBackups = observedSets.map((receiver) => ({
      receiver,
      values: [...receiver.values()],
    }));
    for (const { receiver } of mapBackups) {
      applyForTest(originals.mapClear, receiver, []);
    }
    for (const { receiver } of setBackups) {
      applyForTest(originals.setClear, receiver, []);
    }

    let leaseSurvivedReceiverDamage = true;
    try {
      store.assertLease(guard);
    } catch {
      leaseSurvivedReceiverDamage = false;
    }
    let recoveredAfterReceiverDamage: readonly string[] = [];
    try {
      recoveredAfterReceiverDamage = store.recoverIncompleteSnapshots(
        "2026-07-16T00:11:00.000Z",
      );
    } finally {
      for (const backup of mapBackups) {
        applyForTest(originals.mapClear, backup.receiver, []);
        for (const [key, value] of backup.entries) {
          applyForTest(originals.mapSet, backup.receiver, [key, value]);
        }
      }
      for (const backup of setBackups) {
        applyForTest(originals.setClear, backup.receiver, []);
        for (const value of backup.values) {
          applyForTest(originals.setAdd, backup.receiver, [value]);
        }
      }
    }

    expect(recoveryError).toBeUndefined();
    expect(activeRecovery).toEqual([]);
    expect({
      leaseSurvivedReceiverDamage,
      privateArrayReceivers,
      privateObjectArguments,
      recoveredAfterReceiverDamage,
    }).toEqual({
      leaseSurvivedReceiverDamage: true,
      privateArrayReceivers: 0,
      privateObjectArguments: 0,
      recoveredAfterReceiverDamage: [draft.id],
    });
  });
  /* eslint-enable @typescript-eslint/unbound-method */

  test("captures structuredClone so targeted run recovery rolls back before a later candidate failure", () => {
    const originalStructuredClone = globalThis.structuredClone;
    const store = openStore();
    const leaseName = "apply:clone-atomic";
    store.acquireLease({
      name: leaseName,
      ownerId: "old",
      now: "2026-07-16T02:00:00.000Z",
      expiresAt: "2026-07-16T02:10:00.000Z",
    });
    const oldGuard = {
      name: leaseName,
      ownerId: "old",
      now: "2026-07-16T02:01:00.000Z",
    } as const;

    const createCandidate = (suffix: "early" | "future", startedAt: string) => {
      const plan = parseChangePlan({
        ...changePlanFixture,
        id: `plan_clone_atomic_${suffix}`,
      });
      const run = parseChangeRun({
        ...changeRunFixture,
        id: `run_clone_atomic_${suffix}`,
        planId: plan.id,
        startedAt,
      });
      store.savePlan(plan);
      store.compareAndSetPlanState({
        planId: plan.id,
        expected: ["ready"],
        next: "applying",
      });
      store.createRun({ run, lease: oldGuard });
      store.compareAndSetRunState({
        runId: run.id,
        expected: ["pending"],
        next: "running",
        finishedAt: null,
        lease: oldGuard,
      });
      return run;
    };

    const early = createCandidate("early", "2026-07-16T02:00:00.000Z");
    const future = createCandidate("future", "2026-07-16T03:00:00.000Z");
    store.acquireLease({
      name: leaseName,
      ownerId: "new",
      now: "2026-07-16T02:11:00.000Z",
      expiresAt: "2026-07-16T04:00:00.000Z",
    });
    const restoreStructuredClone = replaceOwnPropertyForTest(
      globalThis,
      "structuredClone",
      <T>(value: T): T => value,
    );

    try {
      expect(() =>
        store.recoverAbandonedRuns({
          binding: accountBindingFixture,
          lease: {
            name: leaseName,
            ownerId: "new",
            now: "2026-07-16T02:12:00.000Z",
          },
        }),
      ).toThrow(/precede|finishedAt/iu);
    } finally {
      restoreStructuredClone();
    }

    expect(globalThis.structuredClone).toBe(originalStructuredClone);
    expect(
      store.recoverAbandonedRuns({
        binding: accountBindingFixture,
        lease: {
          name: leaseName,
          ownerId: "new",
          now: "2026-07-16T03:01:00.000Z",
        },
      }),
    ).toEqual([early.id, future.id]);
  });
});
