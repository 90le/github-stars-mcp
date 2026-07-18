import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { generateToolReference } from "../../../scripts/generate-tool-reference.mjs";

const execFileAsync = promisify(execFile);
const TOOL_NAMES = [
  "github_stars_status",
  "github_stars_sync",
  "github_stars_query",
  "github_lists_query",
  "github_repositories_discover",
  "github_changes_plan",
  "github_changes_inspect",
  "github_changes_apply",
  "github_changes_rollback",
] as const;

describe("generated MCP tool reference", () => {
  beforeAll(async () => {
    await execFileAsync("npm", ["run", "build"], {
      cwd: process.cwd(),
      shell: process.platform === "win32",
      windowsHide: true,
    });
  }, 60_000);

  it("regenerates the committed reference byte-for-byte", async () => {
    const committed = await readFile("docs/tool-reference.md", "utf8");
    const generated = await generateToolReference();
    expect(generated).toBe(committed);
    for (const name of TOOL_NAMES) {
      expect(committed).toContain(`\`${name}\``);
    }
    expect(
      [...committed.matchAll(/^## `github_[a-z_]+`$/gmu)],
    ).toHaveLength(9);
  });

  it("documents strict input, output, and safety metadata for every tool", async () => {
    const committed = await readFile("docs/tool-reference.md", "utf8");
    expect(committed.match(/### Input schema/gu)).toHaveLength(9);
    expect(committed.match(/### Output schema/gu)).toHaveLength(9);
    expect(committed.match(/### Annotations/gu)).toHaveLength(9);
    expect(committed).toContain('"additionalProperties": false');
    expect(committed).toContain('"taskSupport": "forbidden"');
  });
});
