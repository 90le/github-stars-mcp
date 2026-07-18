import { AppError } from "./errors.js";

const UTC_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;
const CANONICAL_YEAR = /^\d{4}-/u;
const freezeIntrinsic = Object.freeze;
/* eslint-disable @typescript-eslint/unbound-method -- Method intrinsics are deliberately captured and invoked only through captured Reflect.apply. */
const INTRINSICS = freezeIntrinsic({
  dateConstructor: Date,
  dateGetTime: Date.prototype.getTime,
  dateGetUTCDate: Date.prototype.getUTCDate,
  dateGetUTCFullYear: Date.prototype.getUTCFullYear,
  dateGetUTCHours: Date.prototype.getUTCHours,
  dateGetUTCMilliseconds: Date.prototype.getUTCMilliseconds,
  dateGetUTCMinutes: Date.prototype.getUTCMinutes,
  dateGetUTCMonth: Date.prototype.getUTCMonth,
  dateGetUTCSeconds: Date.prototype.getUTCSeconds,
  dateToISOString: Date.prototype.toISOString,
  numberFromValue: Number,
  numberIsFinite: Number.isFinite,
  reflectApply: Reflect.apply,
  regExpExec: RegExp.prototype.exec,
  stringPadEnd: String.prototype.padEnd,
});
/* eslint-enable @typescript-eslint/unbound-method */

function datePart(method: (this: Date) => number, value: Date): number {
  return INTRINSICS.reflectApply(method, value, []);
}

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
  const match = INTRINSICS.reflectApply(INTRINSICS.regExpExec, UTC_TIMESTAMP, [
    value,
  ]);
  if (match === null) return timestampError(label);

  const year = INTRINSICS.numberFromValue(match[1]);
  const month = INTRINSICS.numberFromValue(match[2]);
  const day = INTRINSICS.numberFromValue(match[3]);
  const hour = INTRINSICS.numberFromValue(match[4]);
  const minute = INTRINSICS.numberFromValue(match[5]);
  const second = INTRINSICS.numberFromValue(match[6]);
  const fraction = INTRINSICS.reflectApply(
    INTRINSICS.stringPadEnd,
    match[7] ?? "",
    [3, "0"],
  );
  const millisecond = INTRINSICS.numberFromValue(fraction);
  const timestamp = new INTRINSICS.dateConstructor(value);

  if (
    !INTRINSICS.numberIsFinite(datePart(INTRINSICS.dateGetTime, timestamp)) ||
    datePart(INTRINSICS.dateGetUTCFullYear, timestamp) !== year ||
    datePart(INTRINSICS.dateGetUTCMonth, timestamp) + 1 !== month ||
    datePart(INTRINSICS.dateGetUTCDate, timestamp) !== day ||
    datePart(INTRINSICS.dateGetUTCHours, timestamp) !== hour ||
    datePart(INTRINSICS.dateGetUTCMinutes, timestamp) !== minute ||
    datePart(INTRINSICS.dateGetUTCSeconds, timestamp) !== second ||
    datePart(INTRINSICS.dateGetUTCMilliseconds, timestamp) !== millisecond
  ) {
    return timestampError(label);
  }

  const canonical = INTRINSICS.reflectApply(
    INTRINSICS.dateToISOString,
    timestamp,
    [],
  );
  if (
    INTRINSICS.reflectApply(INTRINSICS.regExpExec, CANONICAL_YEAR, [
      canonical,
    ]) === null
  ) {
    return timestampError(label);
  }
  return canonical;
}
