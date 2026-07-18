import type Database from "better-sqlite3";
import { AppError } from "../domain/errors.js";

export function runInImmediateTransaction<T>(
  database: Database.Database,
  operation: () => T,
): T {
  let result: T | undefined;
  database
    .transaction(() => {
      result = operation();
      return undefined;
    })
    .immediate();
  return result as T;
}

export function runInNewImmediateTransaction<T>(
  database: Database.Database,
  operation: () => T,
): T {
  if (database.inTransaction) {
    throw new AppError(
      "PRECONDITION_FAILED",
      "operation requires a new top-level transaction",
    );
  }
  let result: T | undefined;
  database
    .transaction(() => {
      result = operation();
      return undefined;
    })
    .immediate();
  return result as T;
}
