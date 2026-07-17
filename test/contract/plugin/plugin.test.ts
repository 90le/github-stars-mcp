import { spawnSync } from "node:child_process";
import {
  chmod,
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
const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PNG_SIGNATURE = VALID_PNG.subarray(0, 8);
const PACKED_PLUGIN_PATHS = Object.freeze([
  "plugins/github-stars-mcp/.codex-plugin/plugin.json",
  "plugins/github-stars-mcp/.mcp.json",
  "plugins/github-stars-mcp/skills/manage-github-stars/SKILL.md",
]);
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

function runFixtureValidator(
  root: string,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly staticOnly?: boolean;
  } = {},
): ReturnType<typeof spawnSync> {
  const arguments_ = [VALIDATOR_PATH];
  if (options.staticOnly ?? true) arguments_.push("--static-only");
  return spawnSync(process.execPath, arguments_, {
    cwd: root,
    encoding: "utf8",
    env: options.env ?? {},
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

async function addReferencedPng(root: string, contents: Buffer): Promise<void> {
  const assets = join(root, PLUGIN_ROOT, "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(join(assets, "logo.png"), contents);
  await rewriteJson(
    join(root, PLUGIN_ROOT, ".codex-plugin/plugin.json"),
    (manifest) => {
      const interfaceMetadata = manifest.interface as Record<string, unknown>;
      interfaceMetadata.logo = "./assets/logo.png";
    },
  );
}

function pngChunks(contents: Buffer): readonly Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 8;
  while (offset < contents.length) {
    const length = contents.readUInt32BE(offset);
    const end = offset + 12 + length;
    chunks.push(contents.subarray(offset, end));
    offset = end;
  }
  return chunks;
}

function validPngChunks(): readonly [Buffer, Buffer, Buffer] {
  const chunks = pngChunks(VALID_PNG);
  if (chunks.length !== 3) throw new Error("VALID_PNG fixture is malformed");
  return chunks as [Buffer, Buffer, Buffer];
}

function pngCrc32(contents: Buffer): number {
  let crc = 0xffffffff;
  for (const value of contents) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(
    pngCrc32(result.subarray(4, 8 + data.length)),
    8 + data.length,
  );
  return result;
}

async function fakeNpmPackCommand(
  root: string,
  paths: readonly string[],
): Promise<string> {
  const command = join(root, "fake-npm-pack.mjs");
  const output = JSON.stringify([{ files: paths.map((path) => ({ path })) }]);
  await writeFile(
    command,
    `process.stdout.write(${JSON.stringify(output)});\n`,
    "utf8",
  );
  return command;
}

interface FakeCodex {
  readonly bin: string;
  readonly capture: string;
  readonly responses: string;
}

async function fakeCodexCommand(
  root: string,
  configuredResponses: Record<string, unknown> = {},
): Promise<FakeCodex> {
  const bin = join(root, "fake-codex-bin");
  const responses = join(root, "fake-codex-responses.json");
  const capture = join(root, "fake-codex-capture.jsonl");
  const command =
    process.platform === "win32"
      ? join(bin, "node_modules/@openai/codex/bin/codex.js")
      : join(bin, "codex");
  await mkdir(resolve(command, ".."), { recursive: true });
  const source = `${process.platform === "win32" ? "" : `#!${process.execPath}\n`}
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const configured = JSON.parse(
  readFileSync(process.env.CODEX_TEST_RESPONSES, "utf8"),
);
const args = process.argv.slice(2);
const environmentKeys = [
  "CODEX_HOME",
  "HOME",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
];
appendFileSync(
  process.env.CODEX_TEST_CAPTURE,
  JSON.stringify({
    args,
    env: Object.fromEntries(
      environmentKeys.map((key) => [key, process.env[key] ?? null]),
    ),
  }) + "\\n",
);

const pluginList = {
  installed: [
    {
      pluginId: "github-stars-mcp@personal",
      name: "github-stars-mcp",
      marketplaceName: "personal",
      version: "1.0.0",
      installed: true,
      enabled: true,
      source: {
        source: "local",
        path: join(process.cwd(), "plugins/github-stars-mcp"),
      },
      installPolicy: "AVAILABLE",
      authPolicy: "ON_INSTALL",
    },
  ],
  available: [],
};
const mcp = {
  name: "github-stars-mcp",
  enabled: true,
  disabled_reason: null,
  transport: {
    type: "stdio",
    command: "npx",
    args: ["-y", "github-stars-mcp@1.0.0", "--stdio"],
    env: null,
    env_vars: ${JSON.stringify(ENV_ALLOWLIST)},
    cwd: null,
  },
  enabled_tools: null,
  disabled_tools: null,
  startup_timeout_sec: null,
  tool_timeout_sec: 900,
};

let output = {};
if (args[0] === "plugin" && args[1] === "list") {
  if (configured.pluginListMode === "identity-in-note") {
    output = { installed: [], available: [], note: "github-stars-mcp" };
  } else if (configured.pluginListMode === "extra-plugin") {
    output = {
      ...pluginList,
      installed: [
        ...pluginList.installed,
        {
          pluginId: "real-user-plugin@personal",
          name: "real-user-plugin",
          source: { source: "local", path: process.cwd() },
        },
      ],
    };
  } else if (configured.pluginListMode === "wrong-source") {
    output = {
      ...pluginList,
      installed: [
        {
          ...pluginList.installed[0],
          source: {
            source: "local",
            path: join(process.cwd(), "plugins/not-github-stars-mcp"),
          },
        },
      ],
    };
  } else {
    output = configured.pluginList ?? pluginList;
  }
} else if (args[0] === "mcp" && args[1] === "get") {
  if (configured.mcpMode === "wrong-name") {
    output = { ...mcp, name: "github-stars-mcp-shadow" };
  } else if (configured.mcpMode === "wrong-command") {
    output = {
      ...mcp,
      transport: { ...mcp.transport, command: "npx-wrapper" },
    };
  } else if (configured.mcpMode === "extra-arg") {
    output = {
      ...mcp,
      transport: {
        ...mcp.transport,
        args: [...mcp.transport.args, "--unexpected"],
      },
    };
  } else if (configured.mcpMode === "short-env") {
    output = {
      ...mcp,
      transport: {
        ...mcp.transport,
        env_vars: [
          "GITHUB_STARS_TOKEN",
          "GITHUB_STARS_MCP_PLAN_TTL_MINUTES",
        ],
      },
    };
  } else if (configured.mcpMode === "wrong-timeout") {
    output = { ...mcp, tool_timeout_sec: 1 };
  } else {
    output = configured.mcp ?? mcp;
  }
}
process.stdout.write(JSON.stringify(output));
`;
  await writeFile(command, source, "utf8");
  if (process.platform !== "win32") await chmod(command, 0o755);
  await writeFile(
    responses,
    `${JSON.stringify(configuredResponses)}\n`,
    "utf8",
  );
  return { bin, capture, responses };
}

function fakeCodexEnvironment(
  fake: FakeCodex,
  additional: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PATH: fake.bin,
    CODEX_TEST_CAPTURE: fake.capture,
    CODEX_TEST_RESPONSES: fake.responses,
    ...additional,
  };
}

async function readJsonLines(
  path: string,
): Promise<readonly Record<string, unknown>[]> {
  const source = await readFile(path, "utf8");
  return source
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
  }, 15_000);

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

  it("rejects a second workflow skill", async () => {
    await withPluginFixture(async (root) => {
      const skillDirectory = join(root, PLUGIN_ROOT, "skills/second-skill");
      await mkdir(skillDirectory, { recursive: true });
      await writeFile(
        join(skillDirectory, "SKILL.md"),
        "---\nname: second-skill\ndescription: Use when testing.\n---\n",
        "utf8",
      );

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PLUGIN_TREE");
    });
  });

  it("rejects resources bundled under the approved workflow skill", async () => {
    await withPluginFixture(async (root) => {
      const resourceDirectory = join(
        root,
        PLUGIN_ROOT,
        "skills/manage-github-stars/references",
      );
      await mkdir(resourceDirectory, { recursive: true });
      await writeFile(
        join(resourceDirectory, "unexpected.md"),
        "Unexpected resource.\n",
        "utf8",
      );

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PLUGIN_TREE");
    });
  });

  it("rejects an unreferenced presentation file", async () => {
    await withPluginFixture(async (root) => {
      await writeFile(
        join(root, PLUGIN_ROOT, "unexpected.md"),
        "Unexpected file.\n",
        "utf8",
      );

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PLUGIN_TREE");
    });
  });

  it("rejects an unapproved empty directory", async () => {
    await withPluginFixture(async (root) => {
      await mkdir(join(root, PLUGIN_ROOT, "unexpected"), { recursive: true });

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PLUGIN_TREE");
    });
  });

  it("rejects an app descriptor anywhere in the plugin tree", async () => {
    await withPluginFixture(async (root) => {
      await writeFile(join(root, PLUGIN_ROOT, ".app.json"), "{}\n", "utf8");

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PLUGIN_TREE");
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

  it("rejects a referenced image outside the assets directory", async () => {
    await withPluginFixture(async (root) => {
      await writeFile(join(root, PLUGIN_ROOT, "icon.png"), VALID_PNG);
      await rewriteJson(
        join(root, PLUGIN_ROOT, ".codex-plugin/plugin.json"),
        (manifest) => {
          const interfaceMetadata = manifest.interface as Record<
            string,
            unknown
          >;
          interfaceMetadata.composerIcon = "./icon.png";
        },
      );

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("MANIFEST_ASSET");
    });
  });

  it("rejects an unreferenced image under the assets directory", async () => {
    await withPluginFixture(async (root) => {
      const assets = join(root, PLUGIN_ROOT, "assets");
      await mkdir(assets, { recursive: true });
      await writeFile(join(assets, "orphan.png"), VALID_PNG);

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PLUGIN_TREE");
    });
  });

  it("accepts a structurally valid PNG referenced under assets", async () => {
    await withPluginFixture(async (root) => {
      await addReferencedPng(root, VALID_PNG);

      const result = runFixtureValidator(root);
      expect(result).toMatchObject({ status: 0, stderr: "" });
    });
  });

  it("rejects a valid PNG followed by a JavaScript payload", async () => {
    await withPluginFixture(async (root) => {
      await addReferencedPng(
        root,
        Buffer.concat([
          VALID_PNG,
          Buffer.from("\nconsole.log('polyglot');\n", "utf8"),
        ]),
      );

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PLUGIN_ASSET_FORMAT");
    });
  });

  it("rejects a PNG with an invalid chunk CRC", async () => {
    await withPluginFixture(async (root) => {
      const invalid = Buffer.from(VALID_PNG);
      invalid.writeUInt8(
        invalid.readUInt8(invalid.length - 1) ^ 0xff,
        invalid.length - 1,
      );
      await addReferencedPng(root, invalid);

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PLUGIN_ASSET_FORMAT");
    });
  });

  it("rejects a PNG whose chunk length exceeds the remaining file", async () => {
    await withPluginFixture(async (root) => {
      const invalid = Buffer.from(VALID_PNG);
      invalid.writeUInt32BE(0xffffffff, 8);
      await addReferencedPng(root, invalid);

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PLUGIN_ASSET_FORMAT");
    });
  });

  it("requires IHDR to be the first PNG chunk", async () => {
    await withPluginFixture(async (root) => {
      const [ihdr, idat, iend] = validPngChunks();
      await addReferencedPng(
        root,
        Buffer.concat([PNG_SIGNATURE, idat, ihdr, iend]),
      );

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PLUGIN_ASSET_FORMAT");
    });
  });

  it("rejects a PNG containing a second IHDR chunk", async () => {
    await withPluginFixture(async (root) => {
      const [ihdr, idat, iend] = validPngChunks();
      await addReferencedPng(
        root,
        Buffer.concat([PNG_SIGNATURE, ihdr, ihdr, idat, iend]),
      );

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PLUGIN_ASSET_FORMAT");
    });
  });

  it("requires at least one IDAT chunk in a PNG", async () => {
    await withPluginFixture(async (root) => {
      const [ihdr, , iend] = validPngChunks();
      await addReferencedPng(root, Buffer.concat([PNG_SIGNATURE, ihdr, iend]));

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PLUGIN_ASSET_FORMAT");
    });
  });

  it("requires a final IEND chunk in a PNG", async () => {
    await withPluginFixture(async (root) => {
      const [ihdr, idat] = validPngChunks();
      await addReferencedPng(root, Buffer.concat([PNG_SIGNATURE, ihdr, idat]));

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PLUGIN_ASSET_FORMAT");
    });
  });

  it("requires the final IEND chunk to have zero length", async () => {
    await withPluginFixture(async (root) => {
      const [ihdr, idat] = validPngChunks();
      await addReferencedPng(
        root,
        Buffer.concat([
          PNG_SIGNATURE,
          ihdr,
          idat,
          pngChunk("IEND", Buffer.from([0])),
        ]),
      );

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PLUGIN_ASSET_FORMAT");
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

  it("rejects the manifest apps capability even when its target is local", async () => {
    await withPluginFixture(async (root) => {
      await writeFile(join(root, PLUGIN_ROOT, ".app.json"), "{}\n", "utf8");
      await rewriteJson(
        join(root, PLUGIN_ROOT, ".codex-plugin/plugin.json"),
        (manifest) => {
          manifest.apps = "./.app.json";
        },
      );

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("MANIFEST");
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

  it("rejects package files that would ship the test tree", async () => {
    await withPluginFixture(async (root) => {
      await rewriteJson(join(root, "package.json"), (packageMetadata) => {
        packageMetadata.files = [
          "dist",
          "plugins/github-stars-mcp",
          "README.md",
          "LICENSE",
          "test",
        ];
      });
      const testDirectory = join(root, "test");
      await mkdir(testDirectory, { recursive: true });
      await writeFile(
        join(testDirectory, "should-not-ship.txt"),
        "must not ship\n",
        "utf8",
      );

      const result = runFixtureValidator(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PACKAGE_FILES");
    });
  });

  it.each([
    ["test tree", "test/should-not-ship.txt"],
    ["GitHub metadata", ".github/workflows/release.yml"],
    ["agent metadata", ".agents/plugins/marketplace.json"],
    ["local state", "state/github-stars.sqlite"],
    ["credentials", ".env"],
    ["an arbitrary extra path", "CHANGELOG.md"],
  ])("rejects %s in npm pack dry-run output", async (_name, path) => {
    await withPluginFixture(async (root) => {
      const npmEntry = await fakeNpmPackCommand(root, [
        ...PACKED_PLUGIN_PATHS,
        path,
      ]);

      const result = runFixtureValidator(root, {
        staticOnly: false,
        env: { npm_execpath: npmEntry, PATH: "" },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PACKAGE_DRY_RUN_CONTENTS");
    });
  });

  it.each([
    ["SQLite state", "dist/state/github-stars.sqlite"],
    ["root dotenv", "dist/.env"],
    ["nested dotenv variant", "dist/config/local/.env.production.local"],
    ["SQLite3 database", "dist/storage/github-stars.sqlite3"],
    ["DB database", "dist/storage/github-stars.db"],
    ["database extension", "dist/storage/github-stars.database"],
    ["SQLite WAL", "dist/storage/github-stars.sqlite-wal"],
    ["SQLite SHM", "dist/storage/github-stars.sqlite-shm"],
    ["DB WAL", "dist/storage/github-stars.db-wal"],
    ["DB SHM", "dist/storage/github-stars.db-shm"],
    ["credential material", "dist/config/credentials.json"],
    ["token material", "dist/config/token.txt"],
    ["secret material", "dist/config/secret.yaml"],
    ["private key material", "dist/config/private-key.pem"],
    ["auth material", "dist/config/auth.json"],
    ["cookie material", "dist/config/cookie.txt"],
    ["session material", "dist/config/session.dat"],
    ["npm credentials", "dist/.npmrc"],
    ["npm debug log", "dist/npm-debug.log"],
    ["debug log", "dist/logs/debug.log"],
    ["cache directory", "dist/.cache/output.js"],
    ["temporary directory", "dist/tmp/output.js"],
    ["temp directory", "dist/temp/output.js"],
    ["case-varied state", "dist/StAtE/GITHUB-STARS.SQLITE"],
  ])("rejects %s inside an allowed npm pack prefix", async (_name, path) => {
    await withPluginFixture(async (root) => {
      const npmEntry = await fakeNpmPackCommand(root, [
        ...PACKED_PLUGIN_PATHS,
        path,
      ]);

      const result = runFixtureValidator(root, {
        staticOnly: false,
        env: { npm_execpath: npmEntry, PATH: "" },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PACKAGE_DRY_RUN_SENSITIVE_PATH");
    });
  });

  it.each([
    [
      "fine-grained GitHub token",
      "dist/generated/value-one.js",
      'export const value = "github_pat_AAAAAAAAAAAAAAAAAAAA";\n',
    ],
    [
      "classic GitHub token",
      "dist/generated/value-two.js",
      'export const value = "ghp_AAAAAAAAAAAAAAAAAAAA";\n',
    ],
    [
      "bearer authorization",
      "dist/generated/value-three.js",
      'export const value = "Authorization: Bearer not-a-placeholder";\n',
    ],
    [
      "PEM private key",
      "dist/generated/value-four.js",
      "-----BEGIN PRIVATE KEY-----\nnot-a-placeholder\n-----END PRIVATE KEY-----\n",
    ],
  ])(
    "rejects locally readable packed content containing %s",
    async (_name, path, contents) => {
      await withPluginFixture(async (root) => {
        await mkdir(resolve(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), contents, "utf8");
        const npmEntry = await fakeNpmPackCommand(root, [
          ...PACKED_PLUGIN_PATHS,
          path,
        ]);

        const result = runFixtureValidator(root, {
          staticOnly: false,
          env: { npm_execpath: npmEntry, PATH: "" },
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("PACKAGE_DRY_RUN_SENSITIVE_CONTENT");
      });
    },
  );

  it("accepts legitimate compiled runtime artifacts and package metadata", async () => {
    await withPluginFixture(async (root) => {
      const paths = [
        "dist/auth/credential-provider.js",
        "dist/storage/runtime-secret-repository.d.ts",
        "dist/storage/sqlite-database.js.map",
        "dist/storage/state-directory.js",
        "dist/package.json",
      ];
      for (const path of paths) {
        await mkdir(resolve(root, path, ".."), { recursive: true });
        await writeFile(join(root, path), "{}\n", "utf8");
      }
      const npmEntry = await fakeNpmPackCommand(root, [
        ...PACKED_PLUGIN_PATHS,
        ...paths,
      ]);

      const result = runFixtureValidator(root, {
        staticOnly: false,
        env: { npm_execpath: npmEntry, PATH: "" },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    });
  });

  it("isolates every Codex home and XDG directory", async () => {
    await withPluginFixture(async (root) => {
      const fake = await fakeCodexCommand(root);
      const poison = join(root, "real-user-home");
      const result = runFixtureValidator(root, {
        staticOnly: false,
        env: fakeCodexEnvironment(fake, {
          CODEX_HOME: join(poison, "codex"),
          HOME: join(poison, "home"),
          USERPROFILE: join(poison, "profile"),
          XDG_CACHE_HOME: join(poison, "cache"),
          XDG_CONFIG_HOME: join(poison, "config"),
          XDG_DATA_HOME: join(poison, "data"),
          XDG_RUNTIME_DIR: join(poison, "runtime"),
          XDG_STATE_HOME: join(poison, "state"),
        }),
      });

      expect(result).toMatchObject({ status: 0 });
      const calls = await readJsonLines(fake.capture);
      expect(calls).toHaveLength(4);
      for (const call of calls) {
        const environment = call.env as Record<string, string>;
        const codexHome = environment.CODEX_HOME;
        expect(codexHome).toBeTypeOf("string");
        if (typeof codexHome !== "string") {
          throw new Error("fake Codex did not receive CODEX_HOME");
        }
        expect(codexHome).not.toContain(poison);
        expect(environment.HOME).toBe(codexHome);
        expect(environment.USERPROFILE).toBe(codexHome);
        expect(environment.XDG_CACHE_HOME).toBe(join(codexHome, "xdg-cache"));
        expect(environment.XDG_CONFIG_HOME).toBe(join(codexHome, "xdg-config"));
        expect(environment.XDG_DATA_HOME).toBe(join(codexHome, "xdg-data"));
        expect(environment.XDG_RUNTIME_DIR).toBe(
          join(codexHome, "xdg-runtime"),
        );
        expect(environment.XDG_STATE_HOME).toBe(join(codexHome, "xdg-state"));
      }
    });
  });

  it("rejects a Codex plugin identity found only in unrelated text", async () => {
    await withPluginFixture(async (root) => {
      const fake = await fakeCodexCommand(root, {
        pluginListMode: "identity-in-note",
      });
      const result = runFixtureValidator(root, {
        staticOnly: false,
        env: fakeCodexEnvironment(fake),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("CODEX_PLUGIN_LIST_CONTENTS");
    });
  });

  it("rejects extra plugins inherited from another Codex configuration", async () => {
    await withPluginFixture(async (root) => {
      const fake = await fakeCodexCommand(root, {
        pluginListMode: "extra-plugin",
      });
      const result = runFixtureValidator(root, {
        staticOnly: false,
        env: fakeCodexEnvironment(fake),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("CODEX_PLUGIN_LIST_CONTENTS");
    });
  });

  it("rejects the expected Codex plugin loaded from the wrong source", async () => {
    await withPluginFixture(async (root) => {
      const fake = await fakeCodexCommand(root, {
        pluginListMode: "wrong-source",
      });
      const result = runFixtureValidator(root, {
        staticOnly: false,
        env: fakeCodexEnvironment(fake),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("CODEX_PLUGIN_LIST_CONTENTS");
    });
  });

  it.each([
    ["server name", "wrong-name"],
    ["command", "wrong-command"],
    ["complete argument list", "extra-arg"],
    ["ordered environment allowlist", "short-env"],
    ["tool timeout", "wrong-timeout"],
  ])("rejects a Codex MCP response with the wrong %s", async (_name, mode) => {
    await withPluginFixture(async (root) => {
      const fake = await fakeCodexCommand(root, { mcpMode: mode });
      const result = runFixtureValidator(root, {
        staticOnly: false,
        env: fakeCodexEnvironment(fake),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("CODEX_MCP_CONTENTS");
    });
  });
});
