import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GITHUB_MUTATION_METHOD_NAMES } from "../../src/github/allowed-operations.js";

const FORBIDDEN_CAPABILITIES = Object.freeze([
  "deleteRepository",
  "archiveRepository",
  "transferRepository",
  "updateRepository",
  "updateFile",
  "createOrUpdateFile",
  "rawRequest",
]);

function source(relativeUrl: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativeUrl, import.meta.url)),
    "utf8",
  );
}

describe("GitHub capability boundary", () => {
  it("publishes exactly the six reviewed Star and User List mutations", () => {
    expect(GITHUB_MUTATION_METHOD_NAMES).toEqual([
      "star",
      "unstar",
      "createUserList",
      "updateUserList",
      "deleteUserList",
      "setRepositoryListIds",
    ]);
    expect(Object.isFrozen(GITHUB_MUTATION_METHOD_NAMES)).toBe(true);
  });

  it("contains no repository, content, administration, or generic request escape hatch", () => {
    const files = [
      source("../../src/app/ports/github-port.ts"),
      source("../../src/github/octokit-github-adapter.ts"),
    ];
    for (const contents of files) {
      for (const forbidden of FORBIDDEN_CAPABILITIES) {
        expect(contents).not.toContain(forbidden);
      }
      expect(contents).not.toMatch(
        /^\s*(?:public\s+)?(?:async\s+)?(?:request|graphql)\s*\(/mu,
      );
    }
  });
});
