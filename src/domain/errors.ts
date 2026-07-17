import { types as utilTypes } from "node:util";
import type { JsonValue } from "./json.js";
import { redactSecrets, snapshotSecretRegistry } from "./redaction.js";

const freezeIntrinsic = Object.freeze;

export const APP_ERROR_CODES = freezeIntrinsic([
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
] as const);

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

const APP_ERROR_CODE_LOOKUP = freezeIntrinsic(
  Object.fromEntries(APP_ERROR_CODES.map((code) => [code, true] as const)),
) as Readonly<Record<AppErrorCode, true>>;
const INTRINSICS = freezeIntrinsic({
  arrayIsArray: Array.isArray,
  functionHasInstance: Function.prototype[Symbol.hasInstance],
  objectDefineProperty: Object.defineProperty,
  objectGetOwnPropertyDescriptors: Object.getOwnPropertyDescriptors,
  objectHasOwn: Object.hasOwn,
  reflectApply: Reflect.apply,
  utilIsProxy: utilTypes.isProxy,
});

interface AppErrorOptions {
  readonly retryable?: boolean;
  readonly details?: JsonValue;
  readonly secrets?: readonly string[];
  readonly cause?: unknown;
}

export interface SerializedDomainError {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: JsonValue;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly retryable: boolean;
  readonly details: JsonValue;
  readonly secrets: readonly string[];

  constructor(
    code: AppErrorCode,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message);
    INTRINSICS.objectDefineProperty(this, "name", {
      configurable: true,
      enumerable: false,
      value: "AppError",
      writable: true,
    });
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details === undefined ? {} : options.details;
    this.secrets = snapshotSecretRegistry(options.secrets ?? []);
    INTRINSICS.objectDefineProperty(this, "secrets", {
      configurable: false,
      enumerable: false,
      writable: false,
    });

    if (options.cause !== undefined) {
      INTRINSICS.objectDefineProperty(this, "cause", {
        configurable: true,
        value: options.cause,
        writable: true,
      });
    }
  }

  toJSON(): SerializedDomainError {
    return serializeError(this);
  }
}

function isAppErrorCode(value: unknown): value is AppErrorCode {
  return (
    typeof value === "string" &&
    INTRINSICS.objectHasOwn(APP_ERROR_CODE_LOOKUP, value)
  );
}

function internalError(): SerializedDomainError {
  return {
    code: "INTERNAL_ERROR",
    message: "An unexpected internal error occurred",
    retryable: false,
    details: {},
  };
}

function serializeAppError(error: AppError): SerializedDomainError {
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = INTRINSICS.objectGetOwnPropertyDescriptors(error);
  } catch {
    return internalError();
  }

  const code = descriptors.code?.value as unknown;
  const message = descriptors.message?.value as unknown;
  const retryable = descriptors.retryable?.value as unknown;
  const details = descriptors.details?.value as unknown;
  const secrets = descriptors.secrets?.value as unknown;
  if (
    !isAppErrorCode(code) ||
    typeof message !== "string" ||
    typeof retryable !== "boolean" ||
    !INTRINSICS.arrayIsArray(secrets)
  ) {
    return internalError();
  }

  const safeMessage = redactSecrets(message, secrets as readonly string[]);
  if (typeof safeMessage !== "string") return internalError();

  return {
    code,
    message: safeMessage,
    retryable,
    details: redactSecrets(details, secrets as readonly string[]),
  };
}

function isAppError(error: unknown): error is AppError {
  return INTRINSICS.reflectApply(INTRINSICS.functionHasInstance, AppError, [
    error,
  ]);
}

export function serializeError(error: unknown): SerializedDomainError {
  try {
    if (INTRINSICS.utilIsProxy(error)) return internalError();
    return isAppError(error) ? serializeAppError(error) : internalError();
  } catch {
    return internalError();
  }
}
