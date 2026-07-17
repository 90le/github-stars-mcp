import { AppError } from "./errors.js";

const UTC_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;

function timestampError(label: string): never {
  throw new AppError(
    "VALIDATION_ERROR",
    `${label} must be a valid UTC timestamp in YYYY-MM-DDTHH:mm:ss[.SSS]Z form`,
  );
}

/**
 * Validates the project's single timestamp representation and normalizes it
 * to exact millisecond precision. Restricting the year and precision keeps
 * JavaScript and SQLite comparisons identical.
 */
export function canonicalUtcTimestamp(
  value: unknown,
  label = "timestamp",
): string {
  if (typeof value !== "string") return timestampError(label);
  const match = UTC_TIMESTAMP.exec(value);
  if (match === null) return timestampError(label);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
  const timestamp = new Date(value);

  if (
    !Number.isFinite(timestamp.getTime()) ||
    timestamp.getUTCFullYear() !== year ||
    timestamp.getUTCMonth() + 1 !== month ||
    timestamp.getUTCDate() !== day ||
    timestamp.getUTCHours() !== hour ||
    timestamp.getUTCMinutes() !== minute ||
    timestamp.getUTCSeconds() !== second ||
    timestamp.getUTCMilliseconds() !== millisecond
  ) {
    return timestampError(label);
  }

  const canonical = timestamp.toISOString();
  if (!/^\d{4}-/u.test(canonical)) return timestampError(label);
  return canonical;
}
