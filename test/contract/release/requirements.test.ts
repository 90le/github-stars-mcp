import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const SPEC_PATH =
  "docs/superpowers/specs/2026-07-16-github-stars-mcp-design.md";
const ARTIFACT_PATH = "artifacts/requirements.json";

afterEach(async () => {
  await rm(ARTIFACT_PATH, { force: true });
});

describe("requirement evidence", () => {
  it("maps every approved requirement ID to executable evidence", async () => {
    const spec = await readFile(SPEC_PATH, "utf8");
    const matrix = await readFile("docs/verification-matrix.md", "utf8");
    const ids = [...spec.matchAll(/\*\*([A-Z]+-\d+):\*\*/gu)].map(
      (match) => match[1],
    );
    expect(new Set(ids).size).toBe(80);
    for (const id of ids) {
      expect(matrix).toMatch(
        new RegExp(
          `^\\| ${id} \\| \`[^\`]+\` \\| \`[^\`]+\` \\| Verified \\|$`,
          "mu",
        ),
      );
    }
  });

  it("verifies release evidence and emits a complete machine ledger", async () => {
    await execFileAsync(
      process.execPath,
      ["scripts/verify-requirements.mjs", "--release"],
      { cwd: process.cwd(), windowsHide: true },
    );
    const artifact = JSON.parse(await readFile(ARTIFACT_PATH, "utf8")) as {
      schema_version: string;
      total: number;
      verified: number;
      release_mode: boolean;
      requirements: { id: string; status: string }[];
    };
    expect(artifact).toMatchObject({
      schema_version: "1",
      total: 80,
      verified: 80,
      release_mode: true,
    });
    expect(artifact.requirements).toHaveLength(80);
    expect(new Set(artifact.requirements.map(({ id }) => id)).size).toBe(80);
    expect(
      artifact.requirements.every(({ status }) => status === "Verified"),
    ).toBe(true);
  });

  it("enforces final CI and safety-critical branch gates", async () => {
    expect(await readFile(".github/workflows/ci.yml", "utf8")).toContain(
      "npm run verify:all",
    );
    const config = await readFile("vitest.config.ts", "utf8");
    for (const path of [
      "src/domain/**",
      "src/app/services/apply-service.ts",
      "src/domain/redaction.ts",
      "src/github/allowed-operations.ts",
    ]) {
      expect(config).toContain(path);
    }
    expect(config).toMatch(/branches:\s*100/gu);
  });
});
