import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalPluginFixture } from "../../../scripts/codex-plugin-smoke.mjs";

const temporaryRoots: string[] = [];

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local Codex plugin smoke fixture", () => {
  it("rewrites only the copied MCP config to the installed packed CLI", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "github-stars-mcp-fixture-test-"),
    );
    temporaryRoots.push(root);
    const installedPackageRoot = join(root, "installed/github-stars-mcp");
    const marketplaceRoot = join(root, "marketplace");
    await mkdir(join(installedPackageRoot, "dist"), { recursive: true });
    await writeFile(
      join(installedPackageRoot, "dist/cli.js"),
      "#!/usr/bin/env node\n",
      "utf8",
    );

    const fixture = await createLocalPluginFixture({
      installedPackageRoot,
      marketplaceRoot,
      repositoryRoot: resolve("."),
    });
    const copied = await readJson(join(fixture.pluginRoot, ".mcp.json"));
    const copiedServers = copied.mcpServers as Record<
      string,
      Record<string, unknown>
    >;
    expect(copiedServers["github-stars-mcp"]).toMatchObject({
      command: process.execPath,
      args: [join(installedPackageRoot, "dist/cli.js"), "--stdio"],
    });
    expect(fixture.marketplaceName).toBe("personal");
    expect(fixture.pluginSelector).toBe("github-stars-mcp@personal");

    const committed = await readJson("plugins/github-stars-mcp/.mcp.json");
    const committedServers = committed.mcpServers as Record<
      string,
      Record<string, unknown>
    >;
    expect(committedServers["github-stars-mcp"]).toMatchObject({
      command: "npx",
      args: ["-y", "github-stars-mcp@1.0.0", "--stdio"],
    });
  });

  it("keeps the committed local MCP template aligned with the rewrite", async () => {
    const template = await readJson(
      "test/contract/plugin/local.mcp.template.json",
    );
    const servers = template.mcpServers as Record<
      string,
      Record<string, unknown>
    >;
    expect(servers["github-stars-mcp"]).toEqual({
      command: "<node-executable>",
      args: ["<installed-package-root>/dist/cli.js", "--stdio"],
    });
  });
});
