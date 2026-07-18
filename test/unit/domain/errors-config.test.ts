import { describe, expect, test } from "vitest";
import { loadConfig } from "../../../src/config.js";
import { canonicalJsonClone } from "../../../src/domain/canonical-json.js";
import {
  APP_ERROR_CODES,
  AppError,
  serializeError,
} from "../../../src/domain/errors.js";
import type { JsonValue } from "../../../src/domain/json.js";
import { redactSecrets } from "../../../src/domain/redaction.js";

const EXPECTED_ERROR_CODES = [
  "AUTH_REQUIRED",
  "INSUFFICIENT_PERMISSION",
  "CAPABILITY_UNAVAILABLE",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "RATE_LIMITED",
  "SECONDARY_RATE_LIMITED",
  "GITHUB_UNAVAILABLE",
  "STALE_SNAPSHOT",
  "PLAN_EXPIRED",
  "PLAN_HASH_MISMATCH",
  "PLAN_ACCOUNT_MISMATCH",
  "PLAN_TOO_LARGE",
  "PRECONDITION_FAILED",
  "PARTIAL_FAILURE",
  "RECONCILIATION_REQUIRED",
  "STORAGE_ERROR",
  "INTERNAL_ERROR",
] as const;

describe("domain errors and redaction", () => {
  test("exposes the exact stable error-code contract", () => {
    expect(APP_ERROR_CODES).toEqual(EXPECTED_ERROR_CODES);
    expect(APP_ERROR_CODES).toHaveLength(18);
  });

  test("freezes exported codes and rejects caller-injected error codes", () => {
    const unsafeCode = "CALLER_DEFINED_ERROR";
    const mutableCodes = APP_ERROR_CODES as unknown as string[];
    let expanded = false;
    try {
      mutableCodes.push(unsafeCode);
      expanded = true;
    } catch {
      // A frozen public contract rejects the unsafe mutation.
    }

    const error = new AppError("AUTH_REQUIRED", "safe message");
    Object.defineProperty(error, "code", { value: unsafeCode });
    const serialized = serializeError(error);
    if (expanded) mutableCodes.pop();

    expect(Object.isFrozen(APP_ERROR_CODES)).toBe(true);
    expect(serialized.code).toBe("INTERNAL_ERROR");
  });

  test("stores AppError metadata and serializes only its safe public fields", () => {
    const arbitrarySecret = "not-pattern-matched-secret-value";
    const cause = new Error(arbitrarySecret);
    const error = new AppError(
      "AUTH_REQUIRED",
      `credential ${arbitrarySecret} was rejected`,
      {
        retryable: true,
        details: { attempt: 2 },
        secrets: [arbitrarySecret],
        cause,
      },
    );

    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual({ attempt: 2 });
    expect(error.secrets).toEqual([arbitrarySecret]);
    expect(Object.getOwnPropertyDescriptor(error, "secrets")).toMatchObject({
      configurable: false,
      writable: false,
    });
    expect(error.cause).toBe(cause);

    const serialized = serializeError(error);
    expect(serialized).toEqual({
      code: "AUTH_REQUIRED",
      message: "credential [REDACTED] was rejected",
      retryable: true,
      details: { attempt: 2 },
    });
    expect(serialized).not.toHaveProperty("cause");
    expect(serialized).not.toHaveProperty("stack");
  });

  test("keeps array-valued serialized error details valid canonical JSON", () => {
    const serialized = serializeError(
      new AppError(
        "PRECONDITION_FAILED",
        "The operation is blocked by an incomplete dependency",
        {
          retryable: true,
          details: {
            reason: "dependency_blocked",
            dependsOn: ["op_000001"],
          },
        },
      ),
    );

    expect(canonicalJsonClone(serialized)).toEqual({
      code: "PRECONDITION_FAILED",
      message: "The operation is blocked by an incomplete dependency",
      retryable: true,
      details: {
        reason: "dependency_blocked",
        dependsOn: ["op_000001"],
      },
    });
  });

  test("makes direct AppError JSON serialization use the redacted public shape", () => {
    const arbitrarySecret = "direct-json-secret";
    const error = new AppError(
      "AUTH_REQUIRED",
      `bad credential ${arbitrarySecret}`,
      {
        details: {
          authorization: `Bearer ${arbitrarySecret}`,
          subprocess: { stdout: arbitrarySecret },
        },
        secrets: [arbitrarySecret],
        cause: new Error(arbitrarySecret),
      },
    );

    const json = JSON.stringify(error);

    expect(json).not.toContain(arbitrarySecret);
    expect(JSON.parse(json) as unknown).toEqual(serializeError(error));
    expect(Object.getOwnPropertyDescriptor(error, "secrets")).toMatchObject({
      enumerable: false,
    });
  });

  test("snapshots a valid non-enumerable non-Proxy registry", () => {
    const arbitrarySecret = "descriptor-only-secret";
    const registryTarget: string[] = [];
    Object.defineProperty(registryTarget, "0", {
      configurable: true,
      enumerable: false,
      value: arbitrarySecret,
      writable: true,
    });

    const error = new AppError("AUTH_REQUIRED", `bad ${arbitrarySecret}`, {
      details: { stdout: arbitrarySecret },
      secrets: registryTarget,
    });
    Object.defineProperty(registryTarget, "0", {
      value: "caller-mutated-secret",
    });

    expect(error.secrets).toEqual([arbitrarySecret]);
    expect(error.secrets).not.toBe(registryTarget);
    expect(Array.isArray(error.secrets)).toBe(true);
    expect(Object.isFrozen(error.secrets)).toBe(true);
    expect(JSON.stringify(serializeError(error))).not.toContain(
      arbitrarySecret,
    );
    expect(JSON.stringify(error)).not.toContain(arbitrarySecret);
  });

  test("keeps every invalid AppError registry fail-closed without invoking getters or iterators", () => {
    const arbitrarySecret = "invalid-registry-secret";
    let getterCalls = 0;
    let iteratorCalls = 0;
    let indexReads = 0;

    const hole = new Array<string>(1);

    const accessor: string[] = [];
    Object.defineProperty(accessor, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return arbitrarySecret;
      },
    });

    const malformedIndex = [arbitrarySecret];
    Object.defineProperty(malformedIndex, "01", {
      configurable: true,
      value: "malformed-index-secret",
    });

    const extraKey = [arbitrarySecret];
    Object.defineProperty(extraKey, "extra", {
      configurable: true,
      value: "extra-key-secret",
    });

    const symbolKey = [arbitrarySecret];
    Object.defineProperty(symbolKey, Symbol.iterator, {
      configurable: true,
      value: () => {
        iteratorCalls += 1;
        return [arbitrarySecret][Symbol.iterator]();
      },
    });

    const nonString = [arbitrarySecret, 42] as unknown as string[];

    const reflectionFailure = new Proxy([arbitrarySecret], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) iteratorCalls += 1;
        if (
          typeof property === "string" &&
          /^(?:0|[1-9]\d*)$/u.test(property)
        ) {
          indexReads += 1;
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
      ownKeys: () => {
        throw new Error("registry reflection failed");
      },
    });

    const errors = [
      hole,
      accessor,
      malformedIndex,
      extraKey,
      symbolKey,
      nonString,
      reflectionFailure,
    ].map(
      (secrets) =>
        new AppError("AUTH_REQUIRED", `credential ${arbitrarySecret}`, {
          details: {
            authorization: `Bearer ${arbitrarySecret}`,
            stdout: arbitrarySecret,
          },
          secrets,
        }),
    );

    for (const error of errors) {
      const serialized = serializeError(error);
      const directJson = JSON.stringify(error);
      expect(serialized.message).toBe("[REDACTED]");
      expect(serialized.details).toBe("[REDACTED]");
      expect(JSON.stringify(serialized)).not.toContain(arbitrarySecret);
      expect(directJson).not.toContain(arbitrarySecret);
      expect(JSON.parse(directJson) as unknown).toEqual(serialized);
      expect(Object.isFrozen(error.secrets)).toBe(true);
    }
    expect(new Set(errors.map((error) => error.secrets)).size).toBe(1);
    expect(getterCalls).toBe(0);
    expect(iteratorCalls).toBe(0);
    expect(indexReads).toBe(0);
  });

  test("recursively redacts registered secrets and secret-bearing fields without invoking getters", () => {
    const arbitrarySecret = "a7$unpatterned/credential?value";
    let getterCalls = 0;
    const nested: Record<string, unknown> = {
      stdout: `command output: ${arbitrarySecret}`,
      safe: "visible",
    };
    Object.defineProperty(nested, "unsafe", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("unsafe getter invoked");
      },
    });
    const details = {
      authorization: `Bearer ${arbitrarySecret}`,
      ToKeN: "token field value",
      ACCESS_TOKEN: "access token field value",
      Password: "password field value",
      COOKIE: "cookie field value",
      nested: [nested, { cause: { message: arbitrarySecret } }],
      [`field-${arbitrarySecret}`]: "key-secret",
    } as unknown as JsonValue;
    const hostileCause = Object.defineProperty({}, "message", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("cause getter invoked");
      },
    });
    const error = new AppError(
      "AUTH_REQUIRED",
      `bad ${arbitrarySecret}/${arbitrarySecret}`,
      {
        details,
        secrets: ["", arbitrarySecret],
        cause: hostileCause,
      },
    );

    const serialized = serializeError(error);
    const json = JSON.stringify(serialized);

    expect(getterCalls).toBe(0);
    expect(json).not.toContain(arbitrarySecret);
    expect(serialized.message).toBe("bad [REDACTED]/[REDACTED]");
    expect(serialized.details).toMatchObject({
      authorization: "[REDACTED]",
      ToKeN: "[REDACTED]",
      ACCESS_TOKEN: "[REDACTED]",
      Password: "[REDACTED]",
      COOKIE: "[REDACTED]",
      nested: [
        {
          stdout: "command output: [REDACTED]",
          safe: "visible",
        },
        { cause: { message: "[REDACTED]" } },
      ],
      "field-[REDACTED]": "key-secret",
    });
    expect(serialized.details).not.toHaveProperty("cause");
  });

  test("uses descriptor-only traversal without invoking proxy, toJSON, coercion, iterator, getter, or inherited hooks", () => {
    let getterCalls = 0;
    let proxyTrapCalls = 0;
    let toJsonCalls = 0;
    let iteratorCalls = 0;
    let coercionCalls = 0;
    let inheritedAccessorCalls = 0;

    const proxy = new Proxy(
      { visible: "proxy value" },
      {
        getPrototypeOf: () => {
          proxyTrapCalls += 1;
          return Object.prototype;
        },
        ownKeys: () => {
          proxyTrapCalls += 1;
          return ["visible"];
        },
        getOwnPropertyDescriptor: (_target, property) => {
          proxyTrapCalls += 1;
          return property === "visible"
            ? {
                configurable: true,
                enumerable: true,
                value: "proxy value",
                writable: true,
              }
            : undefined;
        },
      },
    );
    const hooks = {
      toJSON: () => {
        toJsonCalls += 1;
        return "toJSON must not run";
      },
      [Symbol.iterator]: () => {
        iteratorCalls += 1;
        return [][Symbol.iterator]();
      },
      [Symbol.toPrimitive]: () => {
        coercionCalls += 1;
        return "coercion must not run";
      },
      toString: () => {
        coercionCalls += 1;
        return "toString must not run";
      },
      valueOf: () => {
        coercionCalls += 1;
        return 1;
      },
    };
    const inheritedPrototype = Object.defineProperty(
      {},
      "inheritedCredential",
      {
        configurable: true,
        enumerable: true,
        get: () => {
          inheritedAccessorCalls += 1;
          return "inherited accessor must not run";
        },
      },
    );
    const inherited = Object.create(inheritedPrototype) as Record<
      string,
      unknown
    >;
    Object.defineProperty(inherited, "visible", {
      configurable: true,
      enumerable: true,
      value: "own value",
      writable: true,
    });
    const value = Object.defineProperties(
      { proxy, hooks, inherited },
      {
        accessor: {
          configurable: true,
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return "getter must not run";
          },
        },
      },
    );

    const redacted = redactSecrets(value);

    expect(redacted).toMatchObject({
      proxy: "[Unsupported object]",
      hooks: {
        toJSON: "[Function]",
        toString: "[Function]",
        valueOf: "[Function]",
      },
      inherited: "[Unsupported object]",
    });
    expect(getterCalls).toBe(0);
    expect(proxyTrapCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
    expect(iteratorCalls).toBe(0);
    expect(coercionCalls).toBe(0);
    expect(inheritedAccessorCalls).toBe(0);
  });

  test("does not consult Array or Set iterators while sanitizing", () => {
    const arrayIteratorDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator,
    );
    const setIteratorDescriptor = Object.getOwnPropertyDescriptor(
      Set.prototype,
      Symbol.iterator,
    );
    if (
      arrayIteratorDescriptor === undefined ||
      !("value" in arrayIteratorDescriptor) ||
      setIteratorDescriptor === undefined ||
      !("value" in setIteratorDescriptor)
    ) {
      throw new Error("iterator descriptors are required");
    }
    const arrayIterator = arrayIteratorDescriptor.value as unknown;
    const setIterator = setIteratorDescriptor.value as unknown;
    let iteratorCalls = 0;
    let redacted: ReturnType<typeof redactSecrets> | undefined;

    try {
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        enumerable: false,
        get: () => {
          iteratorCalls += 1;
          return arrayIterator;
        },
      });
      Object.defineProperty(Set.prototype, Symbol.iterator, {
        configurable: true,
        enumerable: false,
        get: () => {
          iteratorCalls += 1;
          return setIterator;
        },
      });
      redacted = redactSecrets({ message: "visible registered-secret" }, [
        "registered-secret",
      ]);
    } finally {
      Object.defineProperty(
        Array.prototype,
        Symbol.iterator,
        arrayIteratorDescriptor,
      );
      Object.defineProperty(
        Set.prototype,
        Symbol.iterator,
        setIteratorDescriptor,
      );
    }

    expect(iteratorCalls).toBe(0);
    expect(redacted).toEqual({ message: "visible [REDACTED]" });
  });

  test("rejects Proxy secret registries before invoking any Proxy trap", () => {
    const secret = "proxy-registry-secret";
    let trapCalls = 0;
    const target = [secret];
    const proxySecrets = new Proxy(target, {
      getPrototypeOf: (value) => {
        trapCalls += 1;
        return Reflect.getPrototypeOf(value);
      },
      ownKeys: (value) => {
        trapCalls += 1;
        return Reflect.ownKeys(value);
      },
      getOwnPropertyDescriptor: (value, key) => {
        trapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(value, key);
      },
    });

    const redacted = redactSecrets(`leaked ${secret}`, proxySecrets);

    expect(redacted).toBe("[REDACTED]");
    expect(trapCalls).toBe(0);
  });

  test("does not consult mutable Array or RegExp prototype hooks", () => {
    const pushDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "push",
    );
    const testDescriptor = Object.getOwnPropertyDescriptor(
      RegExp.prototype,
      "test",
    );
    const globalDescriptor = Object.getOwnPropertyDescriptor(
      RegExp.prototype,
      "global",
    );
    const unicodeDescriptor = Object.getOwnPropertyDescriptor(
      RegExp.prototype,
      "unicode",
    );
    if (
      pushDescriptor === undefined ||
      !("value" in pushDescriptor) ||
      testDescriptor === undefined ||
      !("value" in testDescriptor) ||
      globalDescriptor === undefined ||
      unicodeDescriptor === undefined
    ) {
      throw new Error("prototype descriptors are required");
    }
    const originalPush = pushDescriptor.value as (
      this: unknown[],
      ...values: unknown[]
    ) => number;
    const originalTest = testDescriptor.value as (
      this: RegExp,
      value: string,
    ) => boolean;
    const token = `ghp_${"D".repeat(36)}`;
    let prototypeHookCalls = 0;
    let redacted: ReturnType<typeof redactSecrets> | undefined;

    try {
      Object.defineProperty(Array.prototype, "push", {
        configurable: true,
        enumerable: false,
        value: function poisonedPush(
          this: unknown[],
          ...values: unknown[]
        ): number {
          prototypeHookCalls += 1;
          return Reflect.apply(originalPush, this, values);
        },
        writable: true,
      });
      Object.defineProperty(RegExp.prototype, "test", {
        configurable: true,
        enumerable: false,
        get: () => {
          prototypeHookCalls += 1;
          return originalTest;
        },
      });
      Object.defineProperty(RegExp.prototype, "global", {
        configurable: true,
        enumerable: false,
        get: () => {
          prototypeHookCalls += 1;
          return true;
        },
      });
      Object.defineProperty(RegExp.prototype, "unicode", {
        configurable: true,
        enumerable: false,
        get: () => {
          prototypeHookCalls += 1;
          return true;
        },
      });
      redacted = redactSecrets({ message: `${token} registered-secret` }, [
        "registered-secret",
      ]);
    } finally {
      Object.defineProperty(Array.prototype, "push", pushDescriptor);
      Object.defineProperty(RegExp.prototype, "test", testDescriptor);
      Object.defineProperty(RegExp.prototype, "global", globalDescriptor);
      Object.defineProperty(RegExp.prototype, "unicode", unicodeDescriptor);
    }

    expect(prototypeHookCalls).toBe(0);
    expect(redacted).toEqual({
      message: "[REDACTED] [REDACTED]",
    });
  });

  test("does not dispatch registered-secret replacement through String @@replace", () => {
    const shortSecret = "registered-secret";
    const longSecret = "registered-secret-long";
    const replaceDescriptor = Object.getOwnPropertyDescriptor(
      String.prototype,
      Symbol.replace,
    );
    let replaceHookCalls = 0;
    let redacted: ReturnType<typeof redactSecrets> | undefined;

    try {
      Object.defineProperty(String.prototype, Symbol.replace, {
        configurable: true,
        enumerable: false,
        get: () => {
          replaceHookCalls += 1;
          return (): string => {
            replaceHookCalls += 1;
            return "poisoned replacement";
          };
        },
      });
      redacted = redactSecrets(`${longSecret}|${shortSecret}|${longSecret}`, [
        shortSecret,
        longSecret,
      ]);
    } finally {
      if (replaceDescriptor === undefined) {
        Reflect.deleteProperty(String.prototype, Symbol.replace);
      } else {
        Object.defineProperty(
          String.prototype,
          Symbol.replace,
          replaceDescriptor,
        );
      }
    }

    expect(replaceHookCalls).toBe(0);
    expect(redacted).toBe("[REDACTED]|[REDACTED]|[REDACTED]");
  });

  test("redacts repeated, overlapping, empty, and long-boundary registered secrets", () => {
    const longPadding = "x".repeat(64 * 1_024);
    const cases = [
      {
        label: "repeated",
        value: "secret|secret|secret",
        secrets: ["secret"],
        expected: "[REDACTED]|[REDACTED]|[REDACTED]",
      },
      {
        label: "non-overlapping match advancement",
        value: "ababa",
        secrets: ["aba"],
        expected: "[REDACTED]ba",
      },
      {
        label: "longest registered secret precedence",
        value: "abcab bc",
        secrets: ["bc", "abcab"],
        expected: "[REDACTED] [REDACTED]",
      },
      {
        label: "empty secret ignored",
        value: "visible",
        secrets: [""],
        expected: "visible",
      },
      {
        label: "long text boundaries",
        value: `edge-secret${longPadding}edge-secret`,
        secrets: ["edge-secret"],
        expected: `[REDACTED]${longPadding}[REDACTED]`,
      },
    ] as const;

    for (const { label, value, secrets, expected } of cases) {
      expect(redactSecrets(value, secrets), label).toBe(expected);
    }
  });

  test("returns prototype-free records and JSON arrays that stringify without inherited hooks", () => {
    const secret = "prototype-free-output-secret";
    const objectInput = { nested: ["visible", secret] };
    const arrayInput = ["visible", secret];
    const secrets = [secret];
    const objectToJsonDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON",
    );
    const arrayToJsonDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "toJSON",
    );
    const arrayIteratorDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator,
    );
    const arrayPushDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "push",
    );
    const numericDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "1",
    );
    if (
      arrayIteratorDescriptor === undefined ||
      !("value" in arrayIteratorDescriptor) ||
      arrayPushDescriptor === undefined ||
      !("value" in arrayPushDescriptor)
    ) {
      throw new Error("array prototype descriptors are required");
    }
    const originalIterator = arrayIteratorDescriptor.value as unknown;
    const originalPush = arrayPushDescriptor.value as unknown;
    let hookCalls = 0;
    let objectJson: string | undefined;
    let arrayJson: string | undefined;
    let objectPrototype: object | null | undefined;
    let nestedArrayPrototype: object | null | undefined;
    let arrayPrototype: object | null | undefined;
    let arraySemantics = false;

    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        enumerable: false,
        get: () => {
          hookCalls += 1;
          return () => {
            hookCalls += 1;
            return "object prototype toJSON ran";
          };
        },
      });
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        enumerable: false,
        get: () => {
          hookCalls += 1;
          return () => {
            hookCalls += 1;
            return "array prototype toJSON ran";
          };
        },
      });
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        enumerable: false,
        get: () => {
          hookCalls += 1;
          return originalIterator;
        },
      });
      Object.defineProperty(Array.prototype, "push", {
        configurable: true,
        enumerable: false,
        get: () => {
          hookCalls += 1;
          return originalPush;
        },
      });
      Object.defineProperty(Object.prototype, "1", {
        configurable: true,
        enumerable: false,
        get: () => {
          hookCalls += 1;
          return "numeric prototype getter ran";
        },
        set: function setNumericProperty(value: unknown): void {
          hookCalls += 1;
          Object.defineProperty(this, "1", {
            configurable: true,
            enumerable: true,
            value,
            writable: true,
          });
        },
      });

      const objectRedacted = redactSecrets(objectInput, secrets);
      const arrayRedacted = redactSecrets(arrayInput, secrets);
      if (
        objectRedacted === null ||
        typeof objectRedacted !== "object" ||
        Array.isArray(objectRedacted)
      ) {
        throw new TypeError("redacted object must remain a record");
      }
      if (!Array.isArray(arrayRedacted)) {
        throw new TypeError("redacted array must retain JSON array semantics");
      }
      const nestedDescriptor = Reflect.getOwnPropertyDescriptor(
        objectRedacted,
        "nested",
      );
      if (
        nestedDescriptor === undefined ||
        !("value" in nestedDescriptor) ||
        !Array.isArray(nestedDescriptor.value)
      ) {
        throw new TypeError("redacted nested array is required");
      }

      objectPrototype = Reflect.getPrototypeOf(objectRedacted);
      nestedArrayPrototype = Reflect.getPrototypeOf(nestedDescriptor.value);
      arrayPrototype = Reflect.getPrototypeOf(arrayRedacted);
      arraySemantics = Array.isArray(arrayRedacted);
      objectJson = JSON.stringify(objectRedacted);
      arrayJson = JSON.stringify(arrayRedacted);
    } finally {
      if (numericDescriptor === undefined) {
        Reflect.deleteProperty(Object.prototype, "1");
      } else {
        Object.defineProperty(Object.prototype, "1", numericDescriptor);
      }
      Object.defineProperty(
        Array.prototype,
        Symbol.iterator,
        arrayIteratorDescriptor,
      );
      Object.defineProperty(Array.prototype, "push", arrayPushDescriptor);
      if (arrayToJsonDescriptor === undefined) {
        Reflect.deleteProperty(Array.prototype, "toJSON");
      } else {
        Object.defineProperty(Array.prototype, "toJSON", arrayToJsonDescriptor);
      }
      if (objectToJsonDescriptor === undefined) {
        Reflect.deleteProperty(Object.prototype, "toJSON");
      } else {
        Object.defineProperty(
          Object.prototype,
          "toJSON",
          objectToJsonDescriptor,
        );
      }
    }

    expect(objectPrototype).toBeNull();
    expect(nestedArrayPrototype).toBeNull();
    expect(arrayPrototype).toBeNull();
    expect(arraySemantics).toBe(true);
    expect(objectJson).toBe('{"nested":["visible","[REDACTED]"]}');
    expect(arrayJson).toBe('["visible","[REDACTED]"]');
    expect(hookCalls).toBe(0);
  });

  test("does not consult poisoned Object prototype indices for sparse arrays or registries", () => {
    const numericDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "1",
    );
    const secret = "sparse-registry-secret";
    const sparseSecrets = new Array<string>(2);
    Object.defineProperty(sparseSecrets, "0", {
      configurable: true,
      enumerable: true,
      value: secret,
      writable: true,
    });
    const sparseValue: unknown[] = ["visible"];
    sparseValue.length = 2;
    let inheritedAccessorCalls = 0;
    let registryResult: ReturnType<typeof redactSecrets> | undefined;
    let arrayResult: ReturnType<typeof redactSecrets> | undefined;

    try {
      Object.defineProperty(Object.prototype, "1", {
        configurable: true,
        enumerable: false,
        get: () => {
          inheritedAccessorCalls += 1;
          return undefined;
        },
        set: function setNumericProperty(value: unknown): void {
          inheritedAccessorCalls += 1;
          Object.defineProperty(this, "1", {
            configurable: true,
            enumerable: true,
            value,
            writable: true,
          });
        },
      });
      registryResult = redactSecrets(`leaked ${secret}`, sparseSecrets);
      arrayResult = redactSecrets(sparseValue);
    } finally {
      if (numericDescriptor === undefined) {
        Reflect.deleteProperty(Object.prototype, "1");
      } else {
        Object.defineProperty(Object.prototype, "1", numericDescriptor);
      }
    }

    expect(inheritedAccessorCalls).toBe(0);
    expect(registryResult).toBe("[REDACTED]");
    expect(arrayResult).toEqual(["visible", "[Unsupported array item]"]);
  });

  test("bounds recursive traversal, handles cycles, and stringifies unsupported values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deepest: Record<string, unknown> = cyclic;
    for (let depth = 0; depth < 25; depth += 1) {
      const next: Record<string, unknown> = {};
      deepest.next = next;
      deepest = next;
    }
    deepest.value = "deep-secret";

    const result = redactSecrets(
      {
        cyclic,
        bigint: 42n,
        missing: undefined,
        nonFinite: Number.POSITIVE_INFINITY,
      },
      ["deep-secret"],
    );
    const json = JSON.stringify(result);

    expect(json).not.toContain("deep-secret");
    expect(json).toContain("[Circular]");
    expect(json).toContain("[Truncated]");
    expect(result).toMatchObject({
      bigint: "42",
      missing: "undefined",
      nonFinite: "Infinity",
    });
  });

  test("returns dense JSON-safe arrays without invoking sparse or accessor indices", () => {
    const hiddenSecret = "hidden-array-secret";
    let getterCalls = 0;
    const hostileArray: unknown[] = ["visible"];
    Object.defineProperty(hostileArray, "1", {
      configurable: true,
      enumerable: false,
      value: hiddenSecret,
    });
    Object.defineProperty(hostileArray, "2", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return hiddenSecret;
      },
    });
    hostileArray.length = 4;

    const redacted = redactSecrets(hostileArray);

    expect(Array.isArray(redacted)).toBe(true);
    if (!Array.isArray(redacted)) {
      throw new TypeError("redacted array must remain an array");
    }
    expect(redacted).toEqual([
      "visible",
      "[Unsupported array item]",
      "[Unsupported array item]",
      "[Unsupported array item]",
    ]);
    expect(
      Array.from({ length: 4 }, (_, index) => Object.hasOwn(redacted, index)),
    ).toEqual([true, true, true, true]);
    expect(getterCalls).toBe(0);
    expect(JSON.stringify(redacted)).not.toContain(hiddenSecret);
  });

  test("fails closed when a registered-secret list cannot be inspected", () => {
    const arbitrarySecret = "credential-secret";
    const hostileSecrets = new Proxy([arbitrarySecret], {
      ownKeys: () => {
        throw new Error("secret registry inspection failed");
      },
    });

    expect(redactSecrets(`leaked ${arbitrarySecret}`, hostileSecrets)).toBe(
      "[REDACTED]",
    );
  });

  test("reads non-enumerable registered secret indices", () => {
    const arbitrarySecret = "non-enumerable-secret";
    const secrets: string[] = [];
    Object.defineProperty(secrets, "0", {
      configurable: true,
      enumerable: false,
      value: arbitrarySecret,
      writable: true,
    });

    expect(redactSecrets(`leaked ${arbitrarySecret}`, secrets)).toBe(
      "leaked [REDACTED]",
    );
  });

  test("fails closed for malformed registered secret arrays without invoking accessors", () => {
    const arbitrarySecret = "registry-secret";
    let getterCalls = 0;
    const holey = new Array<string>(1);
    const accessor: string[] = [];
    Object.defineProperty(accessor, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return arbitrarySecret;
      },
    });
    const malformedIndex = [arbitrarySecret];
    Object.defineProperty(malformedIndex, "01", {
      configurable: true,
      enumerable: false,
      value: "malformed-index-secret",
    });
    const nonString = [arbitrarySecret, 42] as unknown as string[];
    const descriptorFailure = new Proxy([arbitrarySecret], {
      getOwnPropertyDescriptor: () => {
        throw new Error("descriptor inspection failed");
      },
    });

    for (const secrets of [
      holey,
      accessor,
      malformedIndex,
      nonString,
      descriptorFailure,
    ]) {
      expect(redactSecrets(`leaked ${arbitrarySecret}`, secrets)).toBe(
        "[REDACTED]",
      );
    }
    expect(getterCalls).toBe(0);
  });

  test("maps unknown hostile errors to a generic internal error without reading them", () => {
    const arbitrarySecret = "unknown-error-secret";
    let getterCalls = 0;
    const hostile = Object.defineProperties(
      {},
      {
        message: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return arbitrarySecret;
          },
        },
        authorization: {
          enumerable: true,
          get: () => {
            getterCalls += 1;
            return arbitrarySecret;
          },
        },
      },
    );

    const serialized = serializeError(hostile);

    expect(getterCalls).toBe(0);
    expect(serialized.code).toBe("INTERNAL_ERROR");
    expect(serialized.retryable).toBe(false);
    expect(serialized.details).toEqual({});
    expect(JSON.stringify(serialized)).not.toContain(arbitrarySecret);
  });

  test("serializes a top-level Proxy fail-closed without invoking its prototype trap", () => {
    const arbitrarySecret = "proxied-error-prototype-secret";
    let prototypeTrapCalls = 0;
    const proxied = new Proxy(
      new AppError("AUTH_REQUIRED", arbitrarySecret, {
        details: { echo: arbitrarySecret },
        secrets: [arbitrarySecret],
      }),
      {
        getPrototypeOf: () => {
          prototypeTrapCalls += 1;
          throw new Error(arbitrarySecret);
        },
      },
    );

    const serialized = serializeError(proxied);

    expect(prototypeTrapCalls).toBe(0);
    expect(serialized).toEqual({
      code: "INTERNAL_ERROR",
      message: "An unexpected internal error occurred",
      retryable: false,
      details: {},
    });
    expect(JSON.stringify(serialized)).not.toContain(arbitrarySecret);
  });
});

describe("configuration", () => {
  test("uses safe defaults and never exposes or reads credential variables", () => {
    const credentialVariables = new Set([
      "GITHUB_STARS_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
    ]);
    const reads: PropertyKey[] = [];
    const env = new Proxy<NodeJS.ProcessEnv>(
      {
        GITHUB_STARS_MCP_DATA_DIR: "C:\\state",
        GITHUB_STARS_TOKEN: "product-secret",
        GITHUB_TOKEN: "github-secret",
        GH_TOKEN: "cli-secret",
      },
      {
        get(target, property, receiver) {
          reads.push(property);
          if (
            typeof property === "string" &&
            credentialVariables.has(property)
          ) {
            throw new Error(`credential variable ${property} was read`);
          }
          return Reflect.get(target, property, receiver) as string | undefined;
        },
      },
    );

    const config = loadConfig(env, "win32");

    expect(config).toEqual({
      host: "github.com",
      authMode: "auto",
      dataDir: "C:\\state",
      logLevel: "warning",
      readOnly: true,
      maxReadConcurrency: 4,
      writeIntervalMs: 1_000,
      maxPlanActions: 5_000,
      planTtlMinutes: 1_440,
    });
    expect(Object.keys(config)).toEqual([
      "host",
      "authMode",
      "dataDir",
      "logLevel",
      "readOnly",
      "maxReadConcurrency",
      "writeIntervalMs",
      "maxPlanActions",
      "planTtlMinutes",
    ]);
    expect(reads).not.toEqual(
      expect.arrayContaining([...credentialVariables.values()]),
    );
    expect(JSON.stringify(config)).not.toContain("secret");
  });

  test("accepts every supported override and inclusive numeric bound", () => {
    expect(
      loadConfig(
        {
          GITHUB_HOST: "github.com",
          GITHUB_STARS_MCP_AUTH_MODE: "gh",
          GITHUB_STARS_MCP_DATA_DIR: "/srv/github-stars",
          GITHUB_STARS_MCP_LOG_LEVEL: "debug",
          GITHUB_STARS_MCP_READ_ONLY: "false",
          GITHUB_STARS_MCP_MAX_READ_CONCURRENCY: "1",
          GITHUB_STARS_MCP_WRITE_INTERVAL_MS: "1000",
          GITHUB_STARS_MCP_MAX_PLAN_ACTIONS: "1",
          GITHUB_STARS_MCP_PLAN_TTL_MINUTES: "1",
        },
        "linux",
      ),
    ).toEqual({
      host: "github.com",
      authMode: "gh",
      dataDir: "/srv/github-stars",
      logLevel: "debug",
      readOnly: false,
      maxReadConcurrency: 1,
      writeIntervalMs: 1_000,
      maxPlanActions: 1,
      planTtlMinutes: 1,
    });

    const upperBounds = loadConfig(
      {
        GITHUB_STARS_MCP_AUTH_MODE: "env",
        GITHUB_STARS_MCP_DATA_DIR: "/srv/github-stars",
        GITHUB_STARS_MCP_LOG_LEVEL: "error",
        GITHUB_STARS_MCP_READ_ONLY: "true",
        GITHUB_STARS_MCP_MAX_READ_CONCURRENCY: "8",
        GITHUB_STARS_MCP_MAX_PLAN_ACTIONS: "5000",
        GITHUB_STARS_MCP_PLAN_TTL_MINUTES: "10080",
      },
      "linux",
    );
    expect(upperBounds.maxReadConcurrency).toBe(8);
    expect(upperBounds.maxPlanActions).toBe(5_000);
    expect(upperBounds.planTtlMinutes).toBe(10_080);
  });

  test("resolves platform state directories with explicit overrides taking precedence", () => {
    expect(
      loadConfig(
        {
          GITHUB_STARS_MCP_DATA_DIR: "D:\\explicit-state",
          LOCALAPPDATA: "C:\\Users\\octocat\\AppData\\Local",
        },
        "win32",
      ).dataDir,
    ).toBe("D:\\explicit-state");
    expect(
      loadConfig(
        { LOCALAPPDATA: "C:\\Users\\octocat\\AppData\\Local" },
        "win32",
      ).dataDir,
    ).toBe("C:\\Users\\octocat\\AppData\\Local\\github-stars-mcp");
    expect(
      loadConfig(
        {
          XDG_STATE_HOME: "/var/lib/octocat",
          HOME: "/home/octocat",
        },
        "linux",
      ).dataDir,
    ).toBe("/var/lib/octocat/github-stars-mcp");
    expect(loadConfig({ HOME: "/home/octocat" }, "darwin").dataDir).toBe(
      "/home/octocat/.local/state/github-stars-mcp",
    );
  });

  test.each([
    [{ GITHUB_HOST: "enterprise.example" }, /github\.com/u],
    [{ GITHUB_STARS_MCP_AUTH_MODE: "token" }, /AUTH_MODE/u],
    [{ GITHUB_STARS_MCP_LOG_LEVEL: "warn" }, /LOG_LEVEL/u],
    [{ GITHUB_STARS_MCP_READ_ONLY: "1" }, /READ_ONLY/u],
    [{ GITHUB_STARS_MCP_READ_ONLY: "TRUE" }, /READ_ONLY/u],
    [{ GITHUB_STARS_MCP_MAX_READ_CONCURRENCY: "0" }, /1.*8/u],
    [{ GITHUB_STARS_MCP_MAX_READ_CONCURRENCY: "9" }, /1.*8/u],
    [{ GITHUB_STARS_MCP_MAX_READ_CONCURRENCY: "1.5" }, /integer/u],
    [{ GITHUB_STARS_MCP_WRITE_INTERVAL_MS: "999" }, /1000/u],
    [{ GITHUB_STARS_MCP_WRITE_INTERVAL_MS: "1e3" }, /integer/u],
    [{ GITHUB_STARS_MCP_MAX_PLAN_ACTIONS: "0" }, /1.*5000/u],
    [{ GITHUB_STARS_MCP_MAX_PLAN_ACTIONS: "5001" }, /1.*5000/u],
    [{ GITHUB_STARS_MCP_PLAN_TTL_MINUTES: "0" }, /1.*10080/u],
    [{ GITHUB_STARS_MCP_PLAN_TTL_MINUTES: "10081" }, /1.*10080/u],
  ] satisfies readonly [NodeJS.ProcessEnv, RegExp][])(
    "rejects invalid setting %#",
    (invalidSetting, expectedMessage) => {
      expect(() =>
        loadConfig(
          {
            GITHUB_STARS_MCP_DATA_DIR: "/tmp/github-stars",
            ...invalidSetting,
          },
          "linux",
        ),
      ).toThrow(expectedMessage);
    },
  );

  test.each([
    [{ GITHUB_STARS_MCP_DATA_DIR: "relative/state" }, "linux"],
    [{ LOCALAPPDATA: "relative\\state" }, "win32"],
    [{ XDG_STATE_HOME: "relative/state" }, "linux"],
    [{ HOME: "relative/home" }, "darwin"],
  ] satisfies readonly [NodeJS.ProcessEnv, NodeJS.Platform][])(
    "rejects relative state path %#",
    (env, platform) => {
      expect(() => loadConfig(env, platform)).toThrow(/absolute/u);
    },
  );
});
