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
    const documentedNames = [
      ...combined.matchAll(/`(github_[a-z_]+)`/gu),
    ].map((match) => match[1]);
    expect([...new Set(documentedNames)].sort()).toEqual(
      [...toolNames].sort(),
    );

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

  it("uses the current public plan, inspect, and apply field names", async () => {
    for (const path of ["README.md", "docs/plugin.md"] as const) {
      const text = await readFile(path, "utf8");

      expect(text, path).toMatch(/^\s+operations:\s*$/mu);
      expect(text, path).not.toMatch(/^\s+requests:\s*$/mu);
      expect(text, path).toMatch(
        /github_changes_inspect[\s\S]*?kind:\s*"plan"[\s\S]*?id:\s*"plan_/u,
      );
      expect(text, path).toMatch(
        /github_changes_apply[\s\S]*?expected_hash:\s*"<plan_hash>"/u,
      );
      expect(text, path).toMatch(
        /`plan_hash`[\s\S]{0,160}(?:as|into)[\s\S]{0,80}`expected_hash`/u,
      );
    }

    const readme = await readFile("README.md", "utf8");
    expect(readme).toMatch(
      /kind:\s*"unstar"[\s\S]*?repositories:[\s\S]*?repository_ids:/u,
    );
  });

  it("documents all four inspection branches", async () => {
    const readme = await readFile("README.md", "utf8");
    for (const branch of ["plan", "run", "attempts", "reconciliations"]) {
      expect(readme).toContain(`kind: "${branch}"`);
    }
    expect(readme).toMatch(
      /kind:\s*"attempts"[\s\S]*?operation_id:[\s\S]*?kind:\s*"reconciliations"[\s\S]*?operation_id:/u,
    );
  });

  it("documents the public snake-case repository aliases", async () => {
    const documents = await Promise.all(
      requiredFiles.map((path) => readFile(path, "utf8")),
    );
    const combined = documents.join("\n");
    for (const alias of [
      "name_with_owner",
      "stargazers_count",
      "language",
      "license",
      "archived",
      "disabled",
      "fork",
    ]) {
      expect(combined).toContain(`\`${alias}\``);
    }
    for (const internalName of [
      "full_name",
      "stargazer_count",
      "primary_language",
      "license_spdx_id",
      "is_archived",
      "is_disabled",
      "is_fork",
    ]) {
      expect(combined).not.toContain(`\`${internalName}\``);
    }
  });

  it("does not claim that status returns the process read-only setting", async () => {
    for (const path of ["README.md", "docs/plugin.md"] as const) {
      const text = await readFile(path, "utf8");
      expect(text, path).not.toMatch(
        /github_stars_status[\s\S]{0,300}(?:returns?|reports?|identifies)[\s\S]{0,80}read[- ]only/iu,
      );
      expect(text, path).toMatch(
        /does not return[\s\S]{0,100}`GITHUB_STARS_MCP_READ_ONLY`/u,
      );
    }
  });

  it("positions the package as a bounded local MCP server", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).toMatch(/AI (?:agent|host)/u);
    expect(readme).toContain('"mcpServers"');
    expect(readme).toContain('"--stdio"');
    expect(readme).toContain("gh auth login --hostname github.com");
    expect(readme).toMatch(
      /no generic REST, GraphQL, browser, or shell (?:access|tool)/iu,
    );
  });

  it("uses the plural plugin path and no links to ungenerated documents", async () => {
    const plugin = await readFile("docs/plugin.md", "utf8");
    expect(plugin).toContain("plugins/github-stars-mcp");
    expect(plugin).not.toMatch(/(?<!s)\/plugin\/github-stars-mcp/u);

    const readme = await readFile("README.md", "utf8");
    const requirements = await readFile("docs/requirements.md", "utf8");
    expect(readme).not.toContain("docs/tool-reference.md");
    expect(requirements).not.toContain("verification-matrix.md");
  });
});
