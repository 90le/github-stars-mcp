import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { AppError, serializeError } from "../../../src/domain/errors.js";
import { toolFailure, toolSuccess } from "../../../src/mcp/result.js";

type SuccessOptions = Parameters<typeof toolSuccess>[1];

const VALID_OPTIONS = Object.freeze({
  requestId: "req_1",
  summary: "2 repositories",
});

function success(data: unknown, options: unknown = VALID_OPTIONS) {
  return toolSuccess(
    data as Readonly<Record<string, unknown>>,
    options as SuccessOptions,
  );
}

function expectValidationError(callback: () => unknown): AppError {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(serializeError(error).code).toBe("VALIDATION_ERROR");
    return error as AppError;
  }
  throw new Error("Expected a validation error");
}

function textOf(result: ReturnType<typeof toolFailure>): string {
  const content = result.content[0];
  if (content === undefined || content.type !== "text") {
    throw new Error("Expected one text content item");
  }
  return content.text;
}

function failureEnvelope(result: ReturnType<typeof toolFailure>) {
  return result.structuredContent as {
    readonly schema_version: "1";
    readonly ok: false;
    readonly request_id: string;
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly details: unknown;
    };
  };
}

describe("MCP result envelopes", () => {
  it("fills every optional success field with its exact public default", () => {
    expect(
      toolSuccess(
        { total: 2 },
        { requestId: "req_defaults", summary: "2 repositories" },
      ),
    ).toEqual({
      content: [{ type: "text", text: "2 repositories" }],
      structuredContent: {
        schema_version: "1",
        ok: true,
        request_id: "req_defaults",
        data: { total: 2 },
        warnings: [],
        rate_limit: null,
        next_cursor: null,
      },
    });
  });

  it("returns the exact concise success shape accepted by the MCP SDK", () => {
    const result = toolSuccess(
      { total: 2 },
      {
        requestId: "req_1",
        summary: "2 repositories",
        warnings: ["metadata reused"],
        rateLimit: {
          remaining: 4_999,
          resetAt: "2026-07-16T08:00:00.000Z",
        },
        nextCursor: "cursor_1",
      },
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "2 repositories" }],
      structuredContent: {
        schema_version: "1",
        ok: true,
        request_id: "req_1",
        data: { total: 2 },
        warnings: ["metadata reused"],
        rate_limit: {
          remaining: 4_999,
          resetAt: "2026-07-16T08:00:00.000Z",
        },
        next_cursor: "cursor_1",
      },
    });
    expect(result).not.toHaveProperty("isError");
    expect(Object.getPrototypeOf(result.structuredContent)).toBe(
      Object.prototype,
    );
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
  });

  it("returns the exact failure shape without raw exception fields", () => {
    const arbitrarySecret = "not-pattern-matched-secret-value";
    const error = new AppError(
      "AUTH_REQUIRED",
      `credential ${arbitrarySecret} leaked`,
      {
        retryable: true,
        details: {
          authorization: `Bearer ${arbitrarySecret}`,
          echo: arbitrarySecret,
          safe: "visible",
          cause: { message: arbitrarySecret },
          stack: arbitrarySecret,
          command: `gh auth token ${arbitrarySecret}`,
          headers: { cookie: arbitrarySecret },
          stdout: arbitrarySecret,
          stderr: arbitrarySecret,
          rawError: arbitrarySecret,
        },
        secrets: [arbitrarySecret],
        cause: new Error(arbitrarySecret),
      },
    );

    const result = toolFailure(error, "req_2");

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "AUTH_REQUIRED: credential [REDACTED] leaked",
        },
      ],
      structuredContent: {
        schema_version: "1",
        ok: false,
        request_id: "req_2",
        error: {
          code: "AUTH_REQUIRED",
          message: "credential [REDACTED] leaked",
          retryable: true,
          details: { echo: "[REDACTED]", safe: "visible" },
        },
      },
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      arbitrarySecret,
      '"cause"',
      '"stack"',
      '"command"',
      '"headers"',
      '"stdout"',
      '"stderr"',
      '"rawError"',
      '"token"',
      '"secrets"',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
  });

  it("detaches and deeply freezes caller-owned success values", () => {
    const data = {
      nested: { items: [{ value: "original" }] },
    };
    const warnings = ["original warning"];
    const rateLimit = {
      remaining: 12,
      resetAt: "2026-07-16T08:00:00.000Z",
    };
    const options = {
      requestId: "req_detached",
      summary: "detached",
      warnings,
      rateLimit,
      nextCursor: "cursor_original",
    };

    const result = toolSuccess(data, options);

    data.nested.items[0]!.value = "caller mutation";
    warnings[0] = "caller mutation";
    rateLimit.remaining = 0;
    options.nextCursor = "caller mutation";

    expect(result.structuredContent).toMatchObject({
      data: { nested: { items: [{ value: "original" }] } },
      warnings: ["original warning"],
      rate_limit: {
        remaining: 12,
        resetAt: "2026-07-16T08:00:00.000Z",
      },
      next_cursor: "cursor_original",
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const frozenData = structured.data as {
      readonly nested: {
        readonly items: readonly [{ readonly value: string }];
      };
    };
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.content)).toBe(true);
    expect(Object.isFrozen(result.content[0])).toBe(true);
    expect(Object.isFrozen(structured)).toBe(true);
    expect(Object.isFrozen(frozenData)).toBe(true);
    expect(Object.isFrozen(frozenData.nested)).toBe(true);
    expect(Object.isFrozen(frozenData.nested.items)).toBe(true);
    expect(Object.isFrozen(frozenData.nested.items[0])).toBe(true);
    expect(Object.isFrozen(structured.warnings)).toBe(true);
    expect(Object.isFrozen(structured.rate_limit)).toBe(true);
  });

  it("redacts registered arbitrary secrets and token patterns from success text and data", () => {
    const arbitrarySecret = "arbitrary-success-secret";
    const tokenPattern = "ghp_FAKE_TOKEN_VALUE_SHOULD_NOT_CROSS";
    const fineGrainedPattern = "github_pat_FAKE_TOKEN_VALUE_SHOULD_NOT_CROSS";

    const result = toolSuccess(
      {
        token: arbitrarySecret,
        repeated: arbitrarySecret,
        tokenPattern,
        nested: { fineGrainedPattern },
      },
      {
        requestId: "req_redacted",
        summary: `safe ${arbitrarySecret} ${tokenPattern}`,
        warnings: [`warning ${fineGrainedPattern}`],
        nextCursor: `cursor-${tokenPattern}`,
      },
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(arbitrarySecret);
    expect(serialized).not.toContain(tokenPattern);
    expect(serialized).not.toContain(fineGrainedPattern);
    expect(serialized).toContain("[REDACTED]");
    expect(textOf(result)).toBe("safe [REDACTED] [REDACTED]");
  });

  it("redacts token patterns without a leading word boundary from every success field", () => {
    const token = `ghp_${"A".repeat(36)}`;
    const adjacentToken = `prefix${token}`;

    const result = toolSuccess(
      { nested: { value: adjacentToken } },
      {
        requestId: "req_adjacent_token",
        summary: adjacentToken,
        warnings: [adjacentToken],
        nextCursor: adjacentToken,
      },
    );

    expect(result.structuredContent).toMatchObject({
      data: { nested: { value: "prefix[REDACTED]" } },
      warnings: ["prefix[REDACTED]"],
      next_cursor: "prefix[REDACTED]",
    });
    expect(textOf(result)).toBe("prefix[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.each([
    [
      "registered credential",
      "registered-request-secret",
      { token: "registered-request-secret" },
    ],
    ["token at the start", `ghp_${"B".repeat(36)}`, {}],
    ["token after a word character", `prefixghp_${"C".repeat(36)}`, {}],
  ])("uses a fixed success request ID for a %s", (_label, requestId, data) => {
    const result = toolSuccess(data, {
      requestId,
      summary: "safe request",
    });

    expect(result.structuredContent).toMatchObject({
      request_id: "req_redacted",
    });
    expect(JSON.stringify(result)).not.toContain(requestId);
  });

  it("keeps text concise instead of serializing successful data", () => {
    const marker = "structured-only-marker";
    const result = toolSuccess(
      { items: Array.from({ length: 100 }, () => marker) },
      { requestId: "req_concise", summary: "100 items" },
    );

    expect(textOf(result)).toBe("100 items");
    expect(textOf(result)).not.toContain(marker);
  });

  it("never invokes caller getters, proxy traps, toJSON hooks, or iterators", () => {
    let getterCalls = 0;
    let proxyCalls = 0;
    let methodCalls = 0;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "ghp_getter_secret";
      },
    });
    const proxy = new Proxy(
      { safe: "value" },
      {
        get: () => {
          proxyCalls += 1;
          return "ghp_proxy_secret";
        },
        getOwnPropertyDescriptor: () => {
          proxyCalls += 1;
          return undefined;
        },
        getPrototypeOf: () => {
          proxyCalls += 1;
          return Object.prototype;
        },
        ownKeys: () => {
          proxyCalls += 1;
          return [];
        },
      },
    );
    const methods = {
      toJSON: () => {
        methodCalls += 1;
        return { secret: "ghp_to_json_secret" };
      },
      [Symbol.iterator]: () => {
        methodCalls += 1;
        return [][Symbol.iterator]();
      },
    };

    for (const candidate of [accessor, proxy, methods]) {
      expectValidationError(() => success({ candidate }));
    }

    expect(getterCalls).toBe(0);
    expect(proxyCalls).toBe(0);
    expect(methodCalls).toBe(0);
  });

  it("rejects revoked proxies, cycles, sparse arrays, and custom array prototypes", () => {
    const revocable = Proxy.revocable({ safe: true }, {});
    revocable.revoke();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = new Array<string>(1);
    class CustomArray extends Array<string> {}
    const customPrototype = new CustomArray("safe");

    for (const candidate of [
      revocable.proxy,
      cyclic,
      sparse,
      customPrototype,
    ]) {
      expectValidationError(() => success({ candidate }));
    }
  });

  it.each([
    ["symbol", Symbol("unsafe")],
    ["function", () => "unsafe"],
    ["bigint", 1n],
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["Date", new Date("2026-07-16T08:00:00.000Z")],
    ["Map", new Map([["key", "value"]])],
  ])("rejects unsupported successful data value %s", (_label, candidate) => {
    expectValidationError(() => success({ candidate }));
  });
});

describe("success input validation", () => {
  it.each([
    ["a", true],
    ["x".repeat(128), true],
    ["", false],
    ["x".repeat(129), false],
    [" padded", false],
    ["padded ", false],
    ["line\nbreak", false],
    ["nul\u0000value", false],
    ["unpaired-\ud800", false],
  ])("validates request-id boundary %#", (requestId, valid) => {
    const callback = () =>
      toolSuccess(
        {},
        {
          requestId,
          summary: "valid summary",
        },
      );
    if (valid) {
      expect(callback().structuredContent).toMatchObject({
        request_id: requestId,
      });
    } else {
      expectValidationError(callback);
    }
  });

  it.each([
    ["x", true],
    ["x".repeat(1_024), true],
    ["one\ntwo\nthree\nfour", true],
    ["", false],
    ["x".repeat(1_025), false],
    ["one\ntwo\nthree\nfour\nfive", false],
    ["carriage\rreturn", false],
    ["nul\u0000value", false],
    ["unpaired-\udfff", false],
  ])("validates summary boundary %#", (summary, valid) => {
    const callback = () =>
      toolSuccess(
        {},
        {
          requestId: "req_summary",
          summary,
        },
      );
    if (valid) {
      expect(textOf(callback())).toBe(summary);
    } else {
      expectValidationError(callback);
    }
  });

  it("accepts empty and maximum warning lists at the string boundary", () => {
    expect(
      toolSuccess(
        {},
        {
          requestId: "req_empty_warnings",
          summary: "empty warnings",
          warnings: [],
        },
      ).structuredContent,
    ).toMatchObject({ warnings: [] });

    const warnings = Array.from({ length: 20 }, () => "x".repeat(512));
    expect(
      toolSuccess(
        {},
        {
          requestId: "req_max_warnings",
          summary: "maximum warnings",
          warnings,
        },
      ).structuredContent,
    ).toMatchObject({ warnings });
  });

  it.each([
    ["too many", Array.from({ length: 21 }, () => "warning")],
    ["too long", ["x".repeat(513)]],
    ["unpaired", ["warning-\ud800"]],
    ["non-string", ["warning", 1]],
    ["sparse", new Array<string>(1)],
  ])("rejects invalid warnings: %s", (_label, warnings) => {
    expectValidationError(() =>
      success(
        {},
        {
          requestId: "req_warnings",
          summary: "warnings",
          warnings,
        },
      ),
    );
  });

  it("rejects a custom-prototype warnings array", () => {
    class CustomWarnings extends Array<string> {}
    const warnings = new CustomWarnings("warning");

    expectValidationError(() =>
      success(
        {},
        {
          requestId: "req_warnings",
          summary: "warnings",
          warnings,
        },
      ),
    );
  });

  it.each([
    ["null", null, true],
    ["valid", { remaining: 0, resetAt: "2026-07-16T08:00:00.000Z" }, true],
    [
      "maximum remaining",
      {
        remaining: Number.MAX_SAFE_INTEGER,
        resetAt: "2026-07-16T08:00:00.000Z",
      },
      true,
    ],
    [
      "negative remaining",
      { remaining: -1, resetAt: "2026-07-16T08:00:00.000Z" },
      false,
    ],
    [
      "fractional remaining",
      { remaining: 0.5, resetAt: "2026-07-16T08:00:00.000Z" },
      false,
    ],
    [
      "unsafe remaining",
      {
        remaining: Number.MAX_SAFE_INTEGER + 1,
        resetAt: "2026-07-16T08:00:00.000Z",
      },
      false,
    ],
    [
      "noncanonical timestamp",
      { remaining: 0, resetAt: "2026-07-16T08:00:00Z" },
      false,
    ],
    ["malformed timestamp", { remaining: 0, resetAt: "not-a-time" }, false],
    ["missing timestamp", { remaining: 0 }, false],
    [
      "unknown key",
      {
        remaining: 0,
        resetAt: "2026-07-16T08:00:00.000Z",
        token: "unsafe",
      },
      false,
    ],
  ] as const)("validates rate-limit state: %s", (_label, rateLimit, valid) => {
    const callback = () =>
      success(
        {},
        {
          requestId: "req_rate",
          summary: "rate",
          rateLimit,
        },
      );
    if (valid) {
      expect(callback().structuredContent).toMatchObject({
        rate_limit: rateLimit,
      });
    } else {
      expectValidationError(callback);
    }
  });

  it.each([
    [null, true],
    ["x", true],
    ["x".repeat(4_096), true],
    ["", false],
    ["x".repeat(4_097), false],
    ["cursor\nbreak", false],
    ["cursor\u0000break", false],
    ["cursor-\ud800", false],
  ])("validates cursor boundary %#", (nextCursor, valid) => {
    const callback = () =>
      toolSuccess(
        {},
        {
          requestId: "req_cursor",
          summary: "cursor",
          nextCursor,
        },
      );
    if (valid) {
      expect(callback().structuredContent).toMatchObject({
        next_cursor: nextCursor,
      });
    } else {
      expectValidationError(callback);
    }
  });

  it("rejects unknown success option keys without echoing them", () => {
    const secretKey = "unknown-arbitrary-secret-key";
    const error = expectValidationError(() =>
      success(
        {},
        {
          requestId: "req_unknown",
          summary: "unknown",
          [secretKey]: "value",
        },
      ),
    );

    expect(JSON.stringify(serializeError(error))).not.toContain(secretKey);
  });

  it("rejects non-object data and option containers", () => {
    for (const data of [null, [], "text", 1, true]) {
      expectValidationError(() => success(data));
    }
    for (const options of [null, [], "text", 1, true]) {
      expectValidationError(() => success({}, options));
    }
  });

  it("rejects hostile option containers without invoking their traps", () => {
    let getterCalls = 0;
    let proxyCalls = 0;
    const accessor = Object.defineProperty(
      {
        requestId: "req_options",
        summary: "options",
      },
      "warnings",
      {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return ["ghp_getter_secret"];
        },
      },
    );
    const proxy = new Proxy(
      {
        requestId: "req_options",
        summary: "options",
      },
      {
        ownKeys: () => {
          proxyCalls += 1;
          return [];
        },
      },
    );
    const revocable = Proxy.revocable(
      {
        requestId: "req_options",
        summary: "options",
      },
      {},
    );
    revocable.revoke();

    for (const options of [accessor, proxy, revocable.proxy]) {
      expectValidationError(() => success({}, options));
    }
    expect(getterCalls).toBe(0);
    expect(proxyCalls).toBe(0);
  });
});

describe("captured result intrinsics", () => {
  it("redacts success and failure secrets after string replacement methods are replaced", () => {
    const secret = "arbitrary-intrinsic-secret-value";
    const error = new AppError("AUTH_REQUIRED", `credential ${secret} leaked`, {
      details: { echo: secret },
      secrets: [secret],
    });
    const replaceDescriptor = Object.getOwnPropertyDescriptor(
      String.prototype,
      "replace",
    );
    const replaceAllDescriptor = Object.getOwnPropertyDescriptor(
      String.prototype,
      "replaceAll",
    );
    if (replaceDescriptor === undefined || replaceAllDescriptor === undefined) {
      throw new Error("Expected mutable string replacement intrinsics");
    }

    let successJson = "";
    let failureJson = "";
    try {
      Object.defineProperty(String.prototype, "replace", {
        ...replaceDescriptor,
        value(this: string) {
          return String(this);
        },
      });
      Object.defineProperty(String.prototype, "replaceAll", {
        ...replaceAllDescriptor,
        value(this: string) {
          return String(this);
        },
      });

      successJson = JSON.stringify(
        toolSuccess(
          { authorization: secret, echo: secret },
          {
            requestId: "req_intrinsic_redaction",
            summary: `summary ${secret}`,
            warnings: [`warning ${secret}`],
            nextCursor: `cursor-${secret}`,
          },
        ),
      );
      failureJson = JSON.stringify(toolFailure(error, "req_intrinsic_failure"));
    } finally {
      Object.defineProperty(String.prototype, "replace", replaceDescriptor);
      Object.defineProperty(
        String.prototype,
        "replaceAll",
        replaceAllDescriptor,
      );
    }

    expect(successJson).not.toContain(secret);
    expect(failureJson).not.toContain(secret);
  });

  it("redacts without consulting mutable Symbol.replace hooks", () => {
    const secret = "symbol-replace-secret-value";
    const token = `ghp_${"R".repeat(36)}`;
    const regexReplaceDescriptor = Object.getOwnPropertyDescriptor(
      RegExp.prototype,
      Symbol.replace,
    );
    const stringReplaceDescriptor = Object.getOwnPropertyDescriptor(
      String.prototype,
      Symbol.replace,
    );
    if (regexReplaceDescriptor === undefined) {
      throw new Error("Expected RegExp Symbol.replace");
    }

    let successJson = "";
    let failureJson = "";
    const error = new AppError(
      "AUTH_REQUIRED",
      `credential ${secret} and ${token}`,
      {
        details: { echo: secret, tokenEcho: token },
        secrets: [secret],
      },
    );
    try {
      Object.defineProperty(RegExp.prototype, Symbol.replace, {
        configurable: true,
        value(input: string) {
          return input;
        },
        writable: true,
      });
      Object.defineProperty(String.prototype, Symbol.replace, {
        configurable: true,
        value(input: string) {
          return input;
        },
        writable: true,
      });
      successJson = JSON.stringify(
        toolSuccess(
          { authorization: secret, echo: secret, tokenEcho: token },
          {
            requestId: "req_symbol_replace",
            summary: `summary ${secret} and ${token}`,
          },
        ),
      );
      failureJson = JSON.stringify(
        toolFailure(error, "req_symbol_replace_failure"),
      );
    } finally {
      Object.defineProperty(
        RegExp.prototype,
        Symbol.replace,
        regexReplaceDescriptor,
      );
      if (stringReplaceDescriptor === undefined) {
        Reflect.deleteProperty(String.prototype, Symbol.replace);
      } else {
        Object.defineProperty(
          String.prototype,
          Symbol.replace,
          stringReplaceDescriptor,
        );
      }
    }

    for (const serialized of [successJson, failureJson]) {
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(token);
    }
  });

  it("rejects unknown keys after Set.prototype.has is replaced", () => {
    const hasDescriptor = Object.getOwnPropertyDescriptor(Set.prototype, "has");
    if (hasDescriptor === undefined) {
      throw new Error("Expected a mutable Set.has intrinsic");
    }

    let thrown: unknown;
    try {
      Object.defineProperty(Set.prototype, "has", {
        ...hasDescriptor,
        value() {
          return true;
        },
      });
      try {
        success(
          {},
          {
            requestId: "req_unknown_intrinsic",
            summary: "unknown option",
            attackerControlled: true,
          },
        );
      } catch (error) {
        thrown = error;
      }
    } finally {
      Object.defineProperty(Set.prototype, "has", hasDescriptor);
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect(serializeError(thrown).code).toBe("VALIDATION_ERROR");
  });

  it("deeply freezes success and failure results after Object.freeze is replaced", () => {
    const freezeDescriptor = Object.getOwnPropertyDescriptor(Object, "freeze");
    if (freezeDescriptor === undefined) {
      throw new Error("Expected a mutable Object.freeze intrinsic");
    }
    const error = new AppError("NOT_FOUND", "missing", {
      details: { nested: { value: true } },
    });

    let successResult: ReturnType<typeof toolSuccess> | undefined;
    let failureResult: ReturnType<typeof toolFailure> | undefined;
    try {
      Object.defineProperty(Object, "freeze", {
        ...freezeDescriptor,
        value<T>(value: T): Readonly<T> {
          return value;
        },
      });
      successResult = toolSuccess(
        { nested: { value: true } },
        {
          requestId: "req_freeze_intrinsic",
          summary: "frozen",
          warnings: ["warning"],
          rateLimit: {
            remaining: 1,
            resetAt: "2026-07-16T08:00:00.000Z",
          },
        },
      );
      failureResult = toolFailure(error, "req_failure_freeze_intrinsic");
    } finally {
      Object.defineProperty(Object, "freeze", freezeDescriptor);
    }

    if (successResult === undefined || failureResult === undefined) {
      throw new Error("Expected both MCP results");
    }
    const successContent = successResult.structuredContent as {
      readonly data: { readonly nested: object };
      readonly warnings: readonly string[];
      readonly rate_limit: object;
    };
    const failureContent = failureEnvelope(failureResult);
    const failureDetails = failureContent.error.details as {
      readonly nested: object;
    };
    for (const value of [
      successResult,
      successResult.content,
      successResult.content[0],
      successResult.structuredContent,
      successContent.data,
      successContent.data.nested,
      successContent.warnings,
      successContent.rate_limit,
      failureResult,
      failureResult.content,
      failureResult.content[0],
      failureResult.structuredContent,
      failureContent.error,
      failureDetails,
      failureDetails.nested,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("does not invoke inherited array index setters while building results", () => {
    const indexDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      "0",
    );
    const secret = "array-prototype-secret";
    let setterCalls = 0;
    let result: ReturnType<typeof toolSuccess> | undefined;
    try {
      Object.defineProperty(Array.prototype, "0", {
        configurable: true,
        set: () => {
          setterCalls += 1;
        },
      });
      result = toolSuccess(
        { authorization: secret, echo: secret },
        {
          requestId: "req_array_setter",
          summary: `summary ${secret}`,
          warnings: [`warning ${secret}`],
        },
      );
    } finally {
      if (indexDescriptor === undefined) {
        Reflect.deleteProperty(Array.prototype, "0");
      } else {
        Object.defineProperty(Array.prototype, "0", indexDescriptor);
      }
    }

    expect(setterCalls).toBe(0);
    expect(result).toMatchObject({
      content: [{ type: "text", text: "summary [REDACTED]" }],
      structuredContent: {
        request_id: "req_array_setter",
        data: {
          authorization: "[REDACTED]",
          echo: "[REDACTED]",
        },
        warnings: ["warning [REDACTED]"],
      },
    });
  });

  it("does not invoke setters added to AppError.prototype while snapshotting", () => {
    const error = new AppError("RATE_LIMITED", "retry later", {
      retryable: true,
      details: { safe: true },
    });
    const nameDescriptor = Object.getOwnPropertyDescriptor(
      AppError.prototype,
      "name",
    );
    let setterCalls = 0;
    let result: ReturnType<typeof toolFailure> | undefined;
    try {
      Object.defineProperty(AppError.prototype, "name", {
        configurable: true,
        set: () => {
          setterCalls += 1;
        },
      });
      result = toolFailure(error, "req_app_error_setter");
    } finally {
      if (nameDescriptor === undefined) {
        delete (AppError.prototype as { name?: string }).name;
      } else {
        Object.defineProperty(AppError.prototype, "name", nameDescriptor);
      }
    }

    expect(setterCalls).toBe(0);
    expect(result).toMatchObject({
      structuredContent: {
        request_id: "req_app_error_setter",
        error: {
          code: "RATE_LIMITED",
          message: "retry later",
          retryable: true,
          details: { safe: true },
        },
      },
    });
  });

  it("does not invoke AppError prototype setters for validation failures", () => {
    const nameDescriptor = Object.getOwnPropertyDescriptor(
      AppError.prototype,
      "name",
    );
    let setterCalls = 0;
    let thrown: unknown;
    try {
      Object.defineProperty(AppError.prototype, "name", {
        configurable: true,
        set: () => {
          setterCalls += 1;
        },
      });
      try {
        success(
          {},
          {
            requestId: "req_validation_setter",
            summary: "invalid",
            unknown: true,
          },
        );
      } catch (error) {
        thrown = error;
      }
    } finally {
      if (nameDescriptor === undefined) {
        delete (AppError.prototype as { name?: string }).name;
      } else {
        Object.defineProperty(AppError.prototype, "name", nameDescriptor);
      }
    }

    expect(setterCalls).toBe(0);
    expect(thrown).toBeInstanceOf(AppError);
    expect(serializeError(thrown).code).toBe("VALIDATION_ERROR");
  });
});

describe("failure totality", () => {
  it("never throws for primitive, cyclic, accessor, proxy, or revoked failures", () => {
    let getterCalls = 0;
    let proxyCalls = 0;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const accessor = Object.defineProperty({}, "message", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "ghp_getter_secret";
      },
    });
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          proxyCalls += 1;
          throw new Error("proxy trap invoked");
        },
      },
    );
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    const failures: readonly (readonly [unknown, string])[] = [
      [undefined, "req_total"],
      [null, "req_total"],
      [true, "req_total"],
      [42, "req_total"],
      [1n, "req_total"],
      ["string", "req_total"],
      [Symbol("failure"), "req_total"],
      [() => "failure", "req_total"],
      [cyclic, "req_total"],
      [accessor, "req_total"],
      [proxy, "req_redacted"],
      [revocable.proxy, "req_redacted"],
    ];

    for (const [failure, expectedRequestId] of failures) {
      expect(() => toolFailure(failure, "req_total")).not.toThrow();
      expect(failureEnvelope(toolFailure(failure, "req_total"))).toMatchObject({
        schema_version: "1",
        ok: false,
        request_id: expectedRequestId,
        error: {
          code: "INTERNAL_ERROR",
          retryable: false,
          details: {},
        },
      });
    }
    expect(getterCalls).toBe(0);
    expect(proxyCalls).toBe(0);
  });

  it("never throws for malformed AppError subclasses", () => {
    class MalformedAppError extends AppError {
      constructor() {
        super("AUTH_REQUIRED", "safe");
        Object.defineProperty(this, "message", {
          enumerable: true,
          get: () => {
            throw new Error("message getter invoked");
          },
        });
      }
    }

    expect(() =>
      toolFailure(new MalformedAppError(), "req_malformed"),
    ).not.toThrow();
    expect(
      failureEnvelope(toolFailure(new MalformedAppError(), "req_malformed"))
        .error.code,
    ).toBe("INTERNAL_ERROR");
  });

  it.each([
    ["valid lower", "a", "a"],
    ["valid upper", "x".repeat(128), "x".repeat(128)],
    ["empty", "", "req_invalid"],
    ["too long", "x".repeat(129), "req_invalid"],
    ["trimmed", " invalid", "req_invalid"],
    ["control", "invalid\nid", "req_invalid"],
    ["unpaired", "invalid-\ud800", "req_invalid"],
  ])("normalizes failure request IDs: %s", (_label, input, expected) => {
    expect(failureEnvelope(toolFailure(null, input)).request_id).toBe(expected);
  });

  it("preserves a valid request ID for an ordinary unknown Error", () => {
    expect(
      failureEnvelope(toolFailure(new Error("unknown"), "req_unknown"))
        .request_id,
    ).toBe("req_unknown");
  });

  it("normalizes non-string and hostile failure request IDs without reading them", () => {
    let proxyCalls = 0;
    const requestId = new Proxy(
      {},
      {
        get: () => {
          proxyCalls += 1;
          return "ghp_request_id_secret";
        },
      },
    );

    const result = toolFailure(null, requestId as unknown as string);

    expect(failureEnvelope(result).request_id).toBe("req_invalid");
    expect(proxyCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("ghp_request_id_secret");
  });

  it("bounds and token-redacts failure message and text", () => {
    const token = "ghp_FAKE_FAILURE_TOKEN_SHOULD_NOT_CROSS";
    const error = new AppError(
      "GITHUB_UNAVAILABLE",
      `${token}-${"x".repeat(3_000)}`,
      { retryable: true },
    );

    const result = toolFailure(error, "req_bounded");
    const envelope = failureEnvelope(result);

    expect(envelope.error.message.length).toBeLessThanOrEqual(2_048);
    expect(textOf(result).length).toBeLessThanOrEqual(2_128);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(textOf(result)).toBe(
      `GITHUB_UNAVAILABLE: ${envelope.error.message}`,
    );
  });

  it("redacts token patterns without a leading word boundary from failure message and details", () => {
    const token = `ghp_${"D".repeat(36)}`;
    const adjacentToken = `prefix${token}`;
    const error = new AppError("GITHUB_UNAVAILABLE", adjacentToken, {
      details: { nested: { value: adjacentToken } },
    });

    const result = toolFailure(error, "req_adjacent_failure");
    const envelope = failureEnvelope(result);

    expect(envelope.error.message).toBe("prefix[REDACTED]");
    expect(envelope.error.details).toEqual({
      nested: { value: "prefix[REDACTED]" },
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.each([
    ["token at the start", `ghp_${"E".repeat(36)}`],
    ["token after a word character", `prefixghp_${"F".repeat(36)}`],
  ])("uses a fixed failure request ID for a %s", (_label, requestId) => {
    const result = toolFailure(null, requestId);

    expect(failureEnvelope(result).request_id).toBe("req_redacted");
    expect(JSON.stringify(result)).not.toContain(requestId);
  });

  it("uses a fixed failure request ID when it equals an AppError credential", () => {
    const secret = "registered-failure-request-secret";
    const error = new AppError("AUTH_REQUIRED", "authentication failed", {
      secrets: [secret],
    });

    const result = toolFailure(error, secret);

    expect(failureEnvelope(result).request_id).toBe("req_redacted");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not invoke accessors when an AppError secret registry is unsafe", () => {
    let getterCalls = 0;
    const malformed = Object.create(AppError.prototype) as AppError;
    Object.defineProperties(malformed, {
      code: { value: "AUTH_REQUIRED" },
      details: { value: {} },
      message: { value: "authentication failed" },
      retryable: { value: false },
      secrets: {
        get: () => {
          getterCalls += 1;
          return ["req_unsafe_registry"];
        },
      },
    });

    const result = toolFailure(malformed, "req_unsafe_registry");

    expect(failureEnvelope(result).request_id).toBe("req_redacted");
    expect(getterCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("req_unsafe_registry");
  });

  it("does not invoke proxy traps when a failure secret registry cannot be inspected", () => {
    let proxyCalls = 0;
    const secret = "req_proxied_registry";
    const error = new Proxy(
      new AppError("AUTH_REQUIRED", "authentication failed", {
        secrets: [secret],
      }),
      {
        getOwnPropertyDescriptor: () => {
          proxyCalls += 1;
          throw new Error("proxy trap invoked");
        },
        getPrototypeOf: () => {
          proxyCalls += 1;
          throw new Error("proxy trap invoked");
        },
      },
    );

    const result = toolFailure(error, secret);

    expect(failureEnvelope(result).request_id).toBe("req_redacted");
    expect(proxyCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not invoke traps on a proxied AppError secret registry", () => {
    let proxyCalls = 0;
    const secret = "req_nested_proxied_registry";
    const registry = new Proxy([secret], {
      get: (target, key, receiver) => {
        proxyCalls += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
      getOwnPropertyDescriptor: (target, key) => {
        proxyCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf: (target) => {
        proxyCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys: (target) => {
        proxyCalls += 1;
        return Reflect.ownKeys(target);
      },
    });
    const malformed = Object.create(AppError.prototype) as AppError;
    Object.defineProperties(malformed, {
      code: { value: "AUTH_REQUIRED" },
      details: { value: {} },
      message: { value: "authentication failed" },
      retryable: { value: false },
      secrets: { value: registry },
    });

    const result = toolFailure(malformed, secret);

    expect(proxyCalls).toBe(0);
    expect(failureEnvelope(result)).toMatchObject({
      request_id: "req_redacted",
      error: { code: "INTERNAL_ERROR", details: {} },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not invoke traps on top-level or nested proxies in AppError details", () => {
    let proxyCalls = 0;
    const createDetailsProxy = () =>
      new Proxy(
        { value: "safe" },
        {
          get: (target, key, receiver) => {
            proxyCalls += 1;
            return Reflect.get(target, key, receiver) as unknown;
          },
          getOwnPropertyDescriptor: (target, key) => {
            proxyCalls += 1;
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
          getPrototypeOf: (target) => {
            proxyCalls += 1;
            return Reflect.getPrototypeOf(target);
          },
          ownKeys: (target) => {
            proxyCalls += 1;
            return Reflect.ownKeys(target);
          },
        },
      );
    const candidates = [
      createDetailsProxy(),
      { nested: createDetailsProxy() },
    ] as const;

    for (const details of candidates) {
      const result = toolFailure(
        new AppError("AUTH_REQUIRED", "authentication failed", {
          details: details as never,
        }),
        "req_proxied_details",
      );
      expect(failureEnvelope(result)).toMatchObject({
        request_id: "req_proxied_details",
        error: {
          code: "AUTH_REQUIRED",
          message: "authentication failed",
          retryable: false,
          details: {},
        },
      });
    }

    expect(proxyCalls).toBe(0);
  });

  it("does not invoke traps while rejecting a Proxy in an error prototype chain", () => {
    let proxyCalls = 0;
    const hostilePrototype = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          proxyCalls += 1;
          throw new Error("prototype trap invoked");
        },
      },
    );
    const hostile = Object.create(hostilePrototype) as object;

    const result = toolFailure(hostile, "req_hostile_prototype");

    expect(proxyCalls).toBe(0);
    expect(failureEnvelope(result)).toMatchObject({
      request_id: "req_redacted",
      error: { code: "INTERNAL_ERROR", details: {} },
    });
  });

  it("falls back without invoking accessors for revoked Proxy, cycle, and accessor details", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "ghp_accessor_secret";
      },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const revocable = Proxy.revocable({ safe: true }, {});
    revocable.revoke();
    const error = new AppError("AUTH_REQUIRED", "authentication failed", {
      details: {
        accessor,
        cyclic,
        revoked: revocable.proxy,
      } as never,
    });

    const result = toolFailure(error, "req_hostile_details");

    expect(getterCalls).toBe(0);
    expect(failureEnvelope(result)).toMatchObject({
      request_id: "req_hostile_details",
      error: {
        code: "AUTH_REQUIRED",
        message: "authentication failed",
        retryable: false,
        details: {},
      },
    });
  });

  it("preserves AppError metadata without invoking a details accessor", () => {
    let getterCalls = 0;
    const error = new AppError("SECONDARY_RATE_LIMITED", "slow down", {
      retryable: true,
    });
    Object.defineProperty(error, "details", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return { token: "ghp_accessor_must_not_run" };
      },
    });

    const result = toolFailure(error, "req_details_accessor");

    expect(getterCalls).toBe(0);
    expect(failureEnvelope(result)).toMatchObject({
      request_id: "req_details_accessor",
      error: {
        code: "SECONDARY_RATE_LIMITED",
        message: "slow down",
        retryable: true,
        details: {},
      },
    });
  });

  it("preserves AppError metadata when details exceed the safe clone bound", () => {
    const error = new AppError("RATE_LIMITED", "bounded details", {
      retryable: true,
      details: {
        oversized: "x".repeat(1_048_577),
      },
    });

    expect(failureEnvelope(toolFailure(error, "req_details"))).toMatchObject({
      request_id: "req_details",
      error: {
        code: "RATE_LIMITED",
        message: "bounded details",
        retryable: true,
        details: {},
      },
    });
  });

  it("detaches and deeply freezes the complete failure result", () => {
    const details = { nested: { value: "original" } };
    const error = new AppError("STORAGE_ERROR", "storage failed", {
      details,
    });

    const result = toolFailure(error, "req_frozen");
    details.nested.value = "caller mutation";
    const envelope = failureEnvelope(result);
    const outputDetails = envelope.error.details as {
      readonly nested: { readonly value: string };
    };

    expect(outputDetails.nested.value).toBe("original");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.content)).toBe(true);
    expect(Object.isFrozen(result.content[0])).toBe(true);
    expect(Object.isFrozen(result.structuredContent)).toBe(true);
    expect(Object.isFrozen(envelope.error)).toBe(true);
    expect(Object.isFrozen(outputDetails)).toBe(true);
    expect(Object.isFrozen(outputDetails.nested)).toBe(true);
  });
});
