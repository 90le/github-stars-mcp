import type { JsonValue } from "./json.js";
import { redactSecrets } from "./redaction.js";

export const APP_ERROR_CODES = [
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

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

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
    this.name = "AppError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details === undefined ? {} : options.details;
    this.secrets = Object.freeze([...(options.secrets ?? [])]);
    Object.defineProperty(this, "secrets", {
      configurable: false,
      enumerable: true,
      writable: false,
    });

    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: options.cause,
        writable: true,
      });
    }
  }
}

function isAppErrorCode(value: unknown): value is AppErrorCode {
  return (
    typeof value === "string" && APP_ERROR_CODES.some((code) => code === value)
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
    descriptors = Object.getOwnPropertyDescriptors(error);
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
    !Array.isArray(secrets)
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

export function serializeError(error: unknown): SerializedDomainError {
  try {
    return error instanceof AppError
      ? serializeAppError(error)
      : internalError();
  } catch {
    return internalError();
  }
}
