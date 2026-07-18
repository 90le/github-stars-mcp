import type { AppConfig } from "../config.js";
import { redactSecrets } from "../domain/redaction.js";
import { serializeError } from "../domain/errors.js";

export interface LogSink {
  write(chunk: string): unknown;
}

type LogLevel = AppConfig["logLevel"];

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
});

function safeText(value: string, secrets: readonly string[]): string {
  const redacted = redactSecrets(value, secrets);
  return typeof redacted === "string" ? redacted : "[REDACTED]";
}

export function safeErrorMessage(error: unknown): string {
  return serializeError(error).message;
}

export class StderrLogger {
  readonly #minimumPriority: number;
  readonly #sink: LogSink;

  constructor(level: LogLevel, sink: LogSink = process.stderr) {
    this.#minimumPriority = LEVEL_PRIORITY[level];
    this.#sink = sink;
  }

  debug(
    event: string,
    message: string,
    details?: unknown,
    secrets: readonly string[] = [],
  ): void {
    this.#write("debug", event, message, details, secrets);
  }

  info(
    event: string,
    message: string,
    details?: unknown,
    secrets: readonly string[] = [],
  ): void {
    this.#write("info", event, message, details, secrets);
  }

  warning(
    event: string,
    message: string,
    details?: unknown,
    secrets: readonly string[] = [],
  ): void {
    this.#write("warning", event, message, details, secrets);
  }

  error(
    event: string,
    message: string,
    details?: unknown,
    secrets: readonly string[] = [],
  ): void {
    this.#write("error", event, message, details, secrets);
  }

  #write(
    level: LogLevel,
    event: string,
    message: string,
    details: unknown,
    secrets: readonly string[],
  ): void {
    if (LEVEL_PRIORITY[level] < this.#minimumPriority) return;
    const record =
      details === undefined
        ? {
            level,
            event: safeText(event, secrets),
            message: safeText(message, secrets),
          }
        : {
            level,
            event: safeText(event, secrets),
            message: safeText(message, secrets),
            details: redactSecrets(details, secrets),
          };
    try {
      this.#sink.write(`${JSON.stringify(record)}\n`);
    } catch {
      // Diagnostics must never interfere with MCP protocol handling.
    }
  }
}
