import { describe, expect, it } from "vitest";
import { AppError } from "../../../src/domain/errors.js";
import {
  StderrLogger,
  safeErrorMessage,
} from "../../../src/logging/stderr-logger.js";

describe("StderrLogger", () => {
  it("writes one JSON object per line at or above the configured level", () => {
    let output = "";
    const logger = new StderrLogger("warning", {
      write(chunk) {
        output += chunk;
        return true;
      },
    });

    logger.info("startup", "ignored");
    logger.warning("degraded", "Lists unavailable", { optional: true });
    logger.error("shutdown", "Closed");

    const lines = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(lines).toEqual([
      {
        level: "warning",
        event: "degraded",
        message: "Lists unavailable",
        details: { optional: true },
      },
      { level: "error", event: "shutdown", message: "Closed" },
    ]);
  });

  it("redacts registered and explicitly supplied secrets", () => {
    const token = "ghp_example_secret_that_must_not_escape";
    let output = "";
    const logger = new StderrLogger("debug", {
      write(chunk) {
        output += chunk;
        return true;
      },
    });
    const error = new AppError("AUTH_REQUIRED", `bad ${token}`, {
      secrets: [token],
      details: { token },
    });

    logger.error("auth", safeErrorMessage(error), { error, token }, [token]);
    expect(output).not.toContain(token);
    expect(output).toContain("[REDACTED]");
  });

  it("does not let a broken stderr sink fail the server", () => {
    const logger = new StderrLogger("debug", {
      write() {
        throw new Error("closed");
      },
    });
    expect(() => logger.debug("event", "message")).not.toThrow();
  });

  it("maps unknown failures to a fixed public message", () => {
    expect(safeErrorMessage(new Error("private detail"))).toBe(
      "An unexpected internal error occurred",
    );
  });
});
