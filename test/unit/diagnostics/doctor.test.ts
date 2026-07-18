import { describe, expect, it, vi } from "vitest";
import type { GitHubCapabilities } from "../../../src/app/ports/github-port.js";
import {
  doctorExitCode,
  runDoctor,
  type DoctorDependencies,
} from "../../../src/diagnostics/doctor.js";

const AVAILABLE: GitHubCapabilities = Object.freeze({
  starRead: "available",
  starWrite: "unknown",
  listRead: "available",
  listWrite: "unknown",
});

function dependencies(
  overrides: Partial<DoctorDependencies> = {},
): DoctorDependencies {
  return {
    checkRuntime: vi.fn(() => Promise.resolve()),
    checkDatabase: vi.fn(() => Promise.resolve()),
    checkGh: vi.fn(() => Promise.resolve(true)),
    checkCredentials: vi.fn(() => Promise.resolve()),
    checkNetwork: vi.fn(() => Promise.resolve()),
    checkCapabilities: vi.fn(() => Promise.resolve(AVAILABLE)),
    ...overrides,
  };
}

describe("runDoctor", () => {
  it("returns the six checks in stable order for a healthy runtime", async () => {
    const report = await runDoctor(dependencies());

    expect(report.status).toBe("healthy");
    expect(report.checks.map((check) => check.name)).toEqual([
      "runtime",
      "database",
      "gh",
      "credentials",
      "network",
      "capabilities",
    ]);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(doctorExitCode(report)).toBe(0);
  });

  it("reports optional Lists unavailability as degraded", async () => {
    const report = await runDoctor(
      dependencies({
        checkCapabilities: () =>
          Promise.resolve({
            ...AVAILABLE,
            listRead: "unavailable",
            listWrite: "unavailable",
          }),
      }),
    );

    expect(report.status).toBe("degraded");
    expect(report.checks.at(-1)).toMatchObject({
      name: "capabilities",
      status: "degraded",
    });
    expect(doctorExitCode(report)).toBe(2);
  });

  it.each([
    ["runtime", { checkRuntime: () => Promise.reject(new Error("old")) }],
    ["database", { checkDatabase: () => Promise.reject(new Error("db")) }],
    [
      "credentials",
      { checkCredentials: () => Promise.reject(new Error("token")) },
    ],
    ["network", { checkNetwork: () => Promise.reject(new Error("offline")) }],
    [
      "capabilities",
      {
        checkCapabilities: () =>
          Promise.resolve({
            ...AVAILABLE,
            starRead: "unavailable" as const,
          }),
      },
    ],
  ] as const)(
    "marks a required %s failure unusable",
    async (_name, override) => {
      const report = await runDoctor(dependencies(override));
      expect(report.status).toBe("unusable");
      expect(doctorExitCode(report)).toBe(1);
    },
  );

  it("treats the GitHub CLI as optional when another credential source works", async () => {
    const report = await runDoctor(
      dependencies({ checkGh: () => Promise.resolve(false) }),
    );
    expect(report.status).toBe("degraded");
    expect(report.checks[2]).toMatchObject({
      name: "gh",
      status: "degraded",
    });
    expect(doctorExitCode(report)).toBe(2);
  });

  it("never copies thrown diagnostics or credentials into the report", async () => {
    const token = "ghp_example_secret_that_must_not_escape";
    const report = await runDoctor(
      dependencies({
        checkCredentials: () => Promise.reject(new Error(`bad ${token}`)),
      }),
    );
    expect(JSON.stringify(report)).not.toContain(token);
    expect(JSON.stringify(report)).not.toContain("bad");
  });
});
