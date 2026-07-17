import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PLUGIN_ROOT = "plugins/github-stars-mcp";
const VALIDATOR_PATH = resolve("scripts/validate-plugin.mjs");
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

async function withPluginFixture(
  callback: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "github-stars-mcp-plugin-"));
  try {
    await mkdir(join(root, "plugins"), { recursive: true });
    await cp(PLUGIN_ROOT, join(root, PLUGIN_ROOT), { recursive: true });
    await mkdir(join(root, ".agents/plugins"), { recursive: true });
    await cp(
      ".agents/plugins/marketplace.json",
      join(root, ".agents/plugins/marketplace.json"),
    );
    await cp("package.json", join(root, "package.json"));
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runFixtureValidator(root: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [VALIDATOR_PATH, "--static-only"], {
    cwd: root,
    encoding: "utf8",
    env: {},
    timeout: 10_000,
    windowsHide: true,
  });
}

async function rewriteJson(
  path: string,
  update: (value: Record<string, unknown>) => void,
): Promise<void> {
  const value = await readJson(path);
  update(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
    const unsupportedFiles = files.filter(
      (path) =>
        ![
          ".gif",
          ".jpeg",
          ".jpg",
          ".json",
          ".md",
          ".png",
          ".webp",
          ".yaml",
          ".yml",
        ].includes(extname(path).toLowerCase()),
    );
    const contents = await Promise.all(
      files.map((path) =>
        readFile(path).then((value) => value.toString("utf8")),
      ),
    );

    expect(unsupportedFiles).toEqual([]);
    expect(contents.join("\n")).not.toMatch(
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

  it.each([
    ["runtime source", "payload.py", "print('unexpected')"],
    [
      "runtime source disguised as an asset",
      "payload.png",
      "print('unexpected')",
    ],
    [
      "a credential in an arbitrary extension",
      "credential.txt",
      "github_pat_not_a_real_value",
    ],
  ])("rejects %s anywhere in the plugin tree", async (_name, path, source) => {
    await withPluginFixture(async (root) => {
      await writeFile(join(root, PLUGIN_ROOT, path), source, "utf8");

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /PLUGIN_(?:ASSET_FORMAT|RUNTIME_SOURCE|CREDENTIAL_VALUE)/u,
      );
    });
  });

  it("rejects official presentation references that escape the plugin", async () => {
    await withPluginFixture(async (root) => {
      await rewriteJson(
        join(root, PLUGIN_ROOT, ".codex-plugin/plugin.json"),
        (manifest) => {
          const interfaceMetadata = manifest.interface as Record<
            string,
            unknown
          >;
          interfaceMetadata.composerIcon = "../../outside.png";
        },
      );

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("MANIFEST_ASSET");
    });
  });

  it("rejects an app manifest reference that escapes the plugin", async () => {
    await withPluginFixture(async (root) => {
      await rewriteJson(
        join(root, PLUGIN_ROOT, ".codex-plugin/plugin.json"),
        (manifest) => {
          manifest.apps = "../../outside.app.json";
        },
      );

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("MANIFEST_APPS");
    });
  });

  it("rejects an incomplete marketplace root", async () => {
    await withPluginFixture(async (root) => {
      await rewriteJson(
        join(root, ".agents/plugins/marketplace.json"),
        (marketplace) => {
          delete marketplace.name;
        },
      );

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("MARKETPLACE");
    });
  });

  it("rejects a plugin root redirected through a directory link", async () => {
    const outside = await mkdtemp(
      join(tmpdir(), "github-stars-mcp-plugin-outside-"),
    );
    try {
      await cp(PLUGIN_ROOT, outside, { recursive: true });
      await withPluginFixture(async (root) => {
        const pluginRoot = join(root, PLUGIN_ROOT);
        await rm(pluginRoot, { recursive: true });
        await symlink(
          outside,
          pluginRoot,
          process.platform === "win32" ? "junction" : "dir",
        );

        const result = runFixtureValidator(root);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("PLUGIN_ROOT_LINK");
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("requires the exact plugin directory in npm package files", async () => {
    await withPluginFixture(async (root) => {
      await rewriteJson(join(root, "package.json"), (packageMetadata) => {
        packageMetadata.files = ["dist", "README.md", "LICENSE"];
      });

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PACKAGE_FILES");
    });
  });
});
