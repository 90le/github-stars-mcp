import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const PLUGIN_ROOT = "plugins/github-stars-mcp";
const ENV_ALLOWLIST = Object.freeze([
  "GITHUB_STARS_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_HOST",
  "GITHUB_STARS_MCP_DATA_DIR",
  "GITHUB_STARS_MCP_READ_ONLY",
  "GITHUB_STARS_MCP_AUTH_MODE",
  "GITHUB_STARS_MCP_LOG_LEVEL",
  "GITHUB_STARS_MCP_MAX_READ_CONCURRENCY",
  "GITHUB_STARS_MCP_WRITE_INTERVAL_MS",
  "GITHUB_STARS_MCP_MAX_PLAN_ACTIONS",
  "GITHUB_STARS_MCP_PLAN_TTL_MINUTES",
]);

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function filesBelow(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else result.push(path.replaceAll("\\", "/"));
    }
  }
  await visit(root);
  return result.sort();
}

describe("Codex plugin package", () => {
  it("uses official plugin layout and pins the exact MCP package", async () => {
    const manifest = await readJson(`${PLUGIN_ROOT}/.codex-plugin/plugin.json`);
    const mcp = await readJson(`${PLUGIN_ROOT}/.mcp.json`);
    const marketplace = await readJson(".agents/plugins/marketplace.json");
    const servers = mcp.mcpServers as Record<
      string,
      {
        command: string;
        args: readonly string[];
        env_vars: readonly string[];
        tool_timeout_sec: number;
      }
    >;
    const entry = (
      marketplace.plugins as readonly {
        name: string;
        source: { source: string; path: string };
      }[]
    )[0];

    expect(manifest).toMatchObject({
      name: "github-stars-mcp",
      version: "1.0.0",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      license: "Apache-2.0",
    });
    expect(servers["github-stars-mcp"]).toEqual({
      command: "npx",
      args: ["-y", "github-stars-mcp@1.0.0", "--stdio"],
      env_vars: ENV_ALLOWLIST,
      tool_timeout_sec: 900,
    });
    expect(entry).toEqual({
      name: "github-stars-mcp",
      source: {
        source: "local",
        path: "./plugins/github-stars-mcp",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Developer Tools",
    });
  });

  it("contains no credential value or duplicated runtime implementation", async () => {
    const files = await filesBelow(PLUGIN_ROOT);
    const runtimeFiles = files.filter((path) =>
      [".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"].includes(extname(path)),
    );
    const presentation = await Promise.all(
      files
        .filter((path) =>
          [".json", ".md", ".yaml", ".yml"].includes(extname(path)),
        )
        .map((path) => readFile(path, "utf8")),
    );

    expect(runtimeFiles).toEqual([]);
    expect(presentation.join("\n")).not.toMatch(
      /github_pat_|gh[pousr]_[A-Za-z0-9_]{4,}|authorization\s*:\s*bearer/iu,
    );
  });

  it("teaches the complete safe agent workflow and the hard capability boundary", async () => {
    const skill = await readFile(
      `${PLUGIN_ROOT}/skills/manage-github-stars/SKILL.md`,
      "utf8",
    );
    const normalized = skill.toLowerCase();
    for (const required of [
      "github_stars_status",
      "github_stars_sync",
      "github_stars_query",
      "github_changes_plan",
      "github_changes_inspect",
      "github_changes_apply",
      "audit",
      "protected",
      "rollback",
      "repository deletion",
      "archive",
      "transfer",
      "visibility",
      "content changes",
    ]) {
      expect(normalized).toContain(required);
    }
    expect(normalized).not.toMatch(
      /extract.*cookie|broad.*token|classic token/iu,
    );
  });

  it("passes the deterministic repository plugin validator", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/validate-plugin.mjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {},
        timeout: 10_000,
        windowsHide: true,
      },
    );
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toBe("Validated Codex plugin github-stars-mcp\n");
  });
});
