import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const requiredFiles = [
  "README.md",
  "docs/architecture.md",
  "docs/requirements.md",
  "docs/security.md",
  "docs/plugin.md",
  "docs/development.md",
  "docs/troubleshooting.md",
] as const;

const toolNames = [
  "github_stars_status",
  "github_stars_sync",
  "github_stars_query",
  "github_lists_query",
  "github_changes_plan",
  "github_changes_inspect",
  "github_changes_apply",
  "github_changes_rollback",
  "github_repositories_discover",
] as const;

describe("core documentation", () => {
  it("exists and contains no unfinished markers", async () => {
    for (const path of requiredFiles) {
      const text = await readFile(path, "utf8");
      expect(text.length, path).toBeGreaterThan(500);
      expect(text, path).not.toMatch(
        /\b(?:TBD|TODO|FIXME|coming soon)\b/iu,
      );
    }
  });

  it("states the repository safety and credential prohibitions", async () => {
    const security = await readFile("docs/security.md", "utf8");
    expect(security).toMatch(/cannot delete.*repository/iu);
    expect(security).toMatch(/does not store.*token/iu);

    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain("cannot delete, archive, transfer, rename");
    expect(readme).toContain("GITHUB_STARS_MCP_READ_ONLY=true");
  });

  it("documents the complete tool surface and guarded write workflow", async () => {
    const readme = await readFile("README.md", "utf8");
    const architecture = await readFile("docs/architecture.md", "utf8");
    const combined = `${readme}\n${architecture}`;
    for (const name of toolNames) {
      expect(combined).toContain(`\`${name}\``);
    }

    for (const path of ["README.md", "docs/plugin.md"] as const) {
      const text = await readFile(path, "utf8");
      const plan = text.indexOf("github_changes_plan");
      const inspect = text.indexOf("github_changes_inspect", plan + 1);
      const apply = text.indexOf("github_changes_apply", inspect + 1);
      expect(plan, path).toBeGreaterThanOrEqual(0);
      expect(inspect, path).toBeGreaterThan(plan);
      expect(apply, path).toBeGreaterThan(inspect);
    }
  });
});
