import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";

import { pack } from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const verifierPath = resolve(repositoryRoot, "scripts/verify-package.mjs");
const temporaryRoots: string[] = [];
const npmCliPath =
  process.env.npm_execpath ??
  resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");

interface ProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface CommandOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly expectedExitCodes?: readonly number[];
  readonly windowsVerbatimArguments?: boolean;
}

type CommandRunner = (
  command: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<ProcessResult>;

interface VerifierModule {
  readonly defaultRunCommand: CommandRunner;
  readonly verifyPackage: (options: {
    readonly args: readonly string[];
    readonly cwd: string;
    readonly runCommand?: CommandRunner;
  }) => Promise<{
    readonly mode: "packed" | "supplied";
    readonly packInvocations: number;
    readonly tarball: string;
  }>;
}

const doctorChecks = [
  "runtime",
  "database",
  "gh",
  "credentials",
  "network",
  "capabilities",
] as const;

const fixtureCli = `#!/usr/bin/env node
import { isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write("github-stars-mcp - AI-native Star management\\n");
} else if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("1.2.3\\n");
} else if (args.length === 2 && args[0] === "--doctor" && args[1] === "--json") {
  const tokenNames = ["GITHUB_STARS_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"];
  const inheritedConfigNames = [
    "INIT_CWD",
    "OLDPWD",
    "GITHUB_STARS_MCP_LOG_LEVEL",
    "GITHUB_STARS_MCP_MAX_PLAN_ACTIONS",
    "GITHUB_STARS_MCP_MAX_READ_CONCURRENCY",
    "GITHUB_STARS_MCP_PLAN_TTL_MINUTES",
    "GITHUB_STARS_MCP_WRITE_INTERVAL_MS",
    "GITHUB_HOST",
    "npm_lifecycle_event",
    "npm_lifecycle_script",
    "npm_package_json",
  ];
  const environmentIsIsolated =
    isAbsolute(process.env.GITHUB_STARS_MCP_DATA_DIR ?? "") &&
    resolve(process.env.PWD ?? "") === process.cwd() &&
    process.env.GITHUB_STARS_MCP_AUTH_MODE === "env" &&
    process.env.GITHUB_STARS_MCP_READ_ONLY === "true" &&
    tokenNames.every((name) => process.env[name] === undefined) &&
    inheritedConfigNames.every((name) => process.env[name] === undefined);
  if (!environmentIsIsolated) {
    process.stderr.write("doctor environment was not isolated\\n");
    process.exitCode = 9;
  } else {
    const names = ${JSON.stringify(doctorChecks)};
    const checks = names.map((name) => ({
      name,
      status: name === "credentials" || name === "network" || name === "capabilities"
        ? "fail"
        : "pass",
      message: "fixture diagnostic",
    }));
    process.stdout.write(JSON.stringify({ status: "unusable", checks }) + "\\n");
    process.exitCode = 1;
  }
} else {
  process.stderr.write("unexpected arguments\\n");
  process.exitCode = 2;
}
`;

async function createFixture(cliSource = fixtureCli): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "github-stars-package-fixture-"));
  temporaryRoots.push(root);
  const packageJson = {
    name: "github-stars-mcp",
    version: "1.2.3",
    type: "module",
    private: false,
    license: "Apache-2.0",
    engines: { node: ">=22" },
    bin: { "github-stars-mcp": "dist/cli.js" },
    files: [
      "dist",
      "plugins/github-stars-mcp",
      "README.md",
      "LICENSE",
      "SECURITY.md",
      "npm-shrinkwrap.json",
    ],
  };
  const shrinkwrap = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: packageJson.name,
        version: packageJson.version,
        license: packageJson.license,
        bin: packageJson.bin,
        engines: packageJson.engines,
      },
    },
  };

  await Promise.all([
    mkdir(resolve(root, "dist"), { recursive: true }),
    mkdir(resolve(root, "plugins/github-stars-mcp/.codex-plugin"), {
      recursive: true,
    }),
    mkdir(
      resolve(root, "plugins/github-stars-mcp/skills/manage-github-stars"),
      { recursive: true },
    ),
    mkdir(resolve(root, "plugins/github-stars-mcp/assets"), {
      recursive: true,
    }),
  ]);
  await Promise.all([
    writeFile(
      resolve(root, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      resolve(root, "npm-shrinkwrap.json"),
      `${JSON.stringify(shrinkwrap, null, 2)}\n`,
      "utf8",
    ),
    writeFile(resolve(root, "README.md"), "# GitHub Stars MCP\n", "utf8"),
    writeFile(resolve(root, "LICENSE"), "Apache License 2.0\n", "utf8"),
    writeFile(
      resolve(root, "SECURITY.md"),
      "# Security\n\nUse private vulnerability reporting.\n",
      "utf8",
    ),
    writeFile(resolve(root, "dist/cli.js"), cliSource, "utf8"),
    writeFile(
      resolve(root, "plugins/github-stars-mcp/.codex-plugin/plugin.json"),
      `${JSON.stringify(
        {
          name: "github-stars-mcp",
          version: "1.2.3",
          skills: "./skills/",
          mcpServers: "./.mcp.json",
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(
      resolve(root, "plugins/github-stars-mcp/.mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            "github-stars-mcp": {
              command: "npx",
              args: ["-y", "github-stars-mcp@1.2.3", "--stdio"],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(
      resolve(
        root,
        "plugins/github-stars-mcp/skills/manage-github-stars/SKILL.md",
      ),
      "---\nname: manage-github-stars\ndescription: Manage GitHub Stars safely.\n---\n",
      "utf8",
    ),
    writeFile(
      resolve(root, "plugins/github-stars-mcp/assets/icon.png"),
      "fixture-icon",
      "utf8",
    ),
    writeFile(
      resolve(root, "plugins/github-stars-mcp/assets/logo.png"),
      "fixture-logo",
      "utf8",
    ),
  ]);
  await chmod(resolve(root, "dist/cli.js"), 0o755);
  return root;
}

async function packFixture(root: string): Promise<string> {
  const outputRoot = await mkdtemp(join(tmpdir(), "github-stars-tarball-"));
  temporaryRoots.push(outputRoot);
  const result = await execFileAsync(
    process.execPath,
    [npmCliPath, "pack", "--json", "--pack-destination", outputRoot],
    {
      cwd: root,
      encoding: "utf8",
      env: sanitizedEnvironment(),
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    },
  );
  const records = JSON.parse(result.stdout) as { filename?: unknown }[];
  expect(records).toHaveLength(1);
  expect(typeof records[0]?.filename).toBe("string");
  return resolve(outputRoot, String(records[0]?.filename));
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    "BASH_ENV",
    "ENV",
    "GH_TOKEN",
    "GITHUB_STARS_TOKEN",
    "GITHUB_TOKEN",
    "NODE_AUTH_TOKEN",
    "NODE_OPTIONS",
    "NPM_CONFIG_SCRIPT_SHELL",
    "NPM_CONFIG_USERCONFIG",
    "NPM_TOKEN",
    "npm_config_script_shell",
    "npm_config_userconfig",
  ]) {
    delete env[name];
  }
  return env;
}

async function runVerifier(
  cwd: string,
  args: readonly string[],
): Promise<ProcessResult> {
  try {
    const result = await execFileAsync(
      process.execPath,
      [verifierPath, ...args],
      {
        cwd,
        encoding: "utf8",
        env: sanitizedEnvironment(),
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
    return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "number" &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      "stderr" in error &&
      typeof error.stderr === "string"
    ) {
      return {
        exitCode: error.code,
        stderr: error.stderr,
        stdout: error.stdout,
      };
    }
    throw error;
  }
}

async function loadVerifier(): Promise<VerifierModule> {
  const verifierUrl = pathToFileURL(verifierPath).href;
  return (await import(/* @vite-ignore */ verifierUrl)) as VerifierModule;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function writeHostileTarball(
  name: string,
  type: "file" | "symlink" = "file",
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "github-stars-hostile-tarball-"));
  temporaryRoots.push(root);
  const tarball = resolve(root, "hostile.tgz");
  const archive = pack();
  const output = createWriteStream(tarball, { flags: "wx" });
  const completion = new Promise<void>((resolvePromise, reject) => {
    output.once("close", resolvePromise);
    output.once("error", reject);
    archive.once("error", reject);
  });
  archive.pipe(createGzip()).pipe(output);
  archive.entry(
    {
      name,
      type,
      ...(type === "symlink" ? { linkname: "../../outside" } : {}),
    },
    type === "file" ? "hostile" : undefined,
  );
  archive.finalize();
  await completion;
  return tarball;
}

async function treeDigest(root: string): Promise<string> {
  const files: string[] = [];
  async function visit(relative: string): Promise<void> {
    const entries = await readdir(resolve(root, relative), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const next = join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(next);
      } else {
        files.push(
          `${next.replaceAll("\\", "/")}:${await sha256(resolve(root, next))}`,
        );
      }
    }
  }
  await visit("");
  return createHash("sha256").update(files.join("\n")).digest("hex");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("distributable package verification", () => {
  it("exposes package:verify and publishes the plural plugin directory", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as {
      files?: unknown;
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["package:verify"]).toBe(
      "node scripts/verify-package.mjs",
    );
    expect(packageJson.files).toContain("plugins/github-stars-mcp");
    expect(packageJson.files).not.toContain("plugin");
    const npmIgnore = (
      await readFile(resolve(repositoryRoot, ".npmignore"), "utf8")
    ).split(/\r?\n/u);
    expect(npmIgnore).toContain("/assets");
    expect(npmIgnore).not.toContain("assets");
  });

  it("packs once into temporary storage and leaves its source tree unchanged", async () => {
    const fixtureRoot = await createFixture();
    const before = await treeDigest(fixtureRoot);
    const verifier = await loadVerifier();
    let observedPacks = 0;
    const runner: CommandRunner = async (command, args, options) => {
      if (args.includes("pack")) observedPacks += 1;
      return verifier.defaultRunCommand(command, args, options);
    };

    const result = await verifier.verifyPackage({
      args: [],
      cwd: fixtureRoot,
      runCommand: runner,
    });

    expect(result).toMatchObject({
      mode: "packed",
      packInvocations: 1,
    });
    expect(observedPacks).toBe(1);
    expect(await treeDigest(fixtureRoot)).toBe(before);
    expect(
      (await readdir(fixtureRoot)).some((name) => name.endsWith(".tgz")),
    ).toBe(false);
  }, 30_000);

  it.each(["prepack", "postpack"])(
    "does not execute a package %s lifecycle script",
    async (lifecycle) => {
      const fixtureRoot = await createFixture();
      const manifestPath = resolve(fixtureRoot, "package.json");
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as Record<string, unknown>;
      manifest.scripts = {
        [lifecycle]:
          "node -e \"require('node:fs').writeFileSync('pack-script-ran','unsafe')\"",
      };
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      const verifier = await loadVerifier();

      await expect(
        verifier.verifyPackage({
          args: [],
          cwd: fixtureRoot,
        }),
      ).rejects.toThrow("lifecycle scripts are forbidden");
      await expect(
        stat(resolve(fixtureRoot, "pack-script-ran")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
    30_000,
  );

  it("verifies a caller-supplied tarball without repacking or mutating it", async () => {
    const fixtureRoot = await createFixture();
    const tarball = await packFixture(fixtureRoot);
    const digestBefore = await sha256(tarball);
    const metadataBefore = await stat(tarball);
    const verifier = await loadVerifier();
    const inheritedEnvironment = {
      GITHUB_HOST: "enterprise.invalid",
      GITHUB_STARS_MCP_LOG_LEVEL: "invalid",
      INIT_CWD: fixtureRoot,
      npm_lifecycle_event: "package:verify",
      npm_lifecycle_script: "node scripts/verify-package.mjs",
      npm_package_json: resolve(fixtureRoot, "package.json"),
      OLDPWD: fixtureRoot,
    } as const;
    const previousEnvironment = new Map(
      Object.keys(inheritedEnvironment).map((name) => [
        name,
        process.env[name],
      ]),
    );
    let isolatedInstall = false;
    let observedPacks = 0;
    const runner: CommandRunner = async (command, args, options) => {
      if (args.includes("pack")) observedPacks += 1;
      if (args.includes("install")) {
        const userConfig = options.env.NPM_CONFIG_USERCONFIG;
        expect(typeof userConfig).toBe("string");
        expect(resolve(String(userConfig))).toBe(String(userConfig));
        expect(await readFile(String(userConfig), "utf8")).toContain(
          "registry=https://registry.npmjs.org/",
        );
        expect(options.env.GITHUB_TOKEN).toBeUndefined();
        expect(options.env.NODE_OPTIONS).toBeUndefined();
        isolatedInstall = true;
      }
      return verifier.defaultRunCommand(command, args, options);
    };

    for (const [name, value] of Object.entries(inheritedEnvironment)) {
      process.env[name] = value;
    }
    const result = await (async () => {
      try {
        return await verifier.verifyPackage({
          args: ["--tarball", tarball],
          cwd: fixtureRoot,
          runCommand: runner,
        });
      } finally {
        for (const [name, value] of previousEnvironment) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    })();

    expect(result).toMatchObject({
      mode: "supplied",
      packInvocations: 0,
      tarball: resolve(tarball),
    });
    expect(observedPacks).toBe(0);
    expect(isolatedInstall).toBe(true);
    expect(await sha256(tarball)).toBe(digestBefore);
    expect((await stat(tarball)).mtimeMs).toBe(metadataBefore.mtimeMs);
  }, 30_000);

  it("rejects a supplied tarball after its source manifest drifts", async () => {
    const fixtureRoot = await createFixture();
    const tarball = await packFixture(fixtureRoot);
    const manifestPath = resolve(fixtureRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    manifest.description = "Changed after packing";
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    const result = await runVerifier(fixtureRoot, ["--tarball", tarball]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("source tree");
  }, 30_000);

  it("can verify the same supplied tarball twice", async () => {
    const fixtureRoot = await createFixture();
    const tarball = await packFixture(fixtureRoot);
    const before = await sha256(tarball);

    const first = await runVerifier(fixtureRoot, ["--tarball", tarball]);
    const second = await runVerifier(fixtureRoot, ["--tarball", tarball]);

    expect(first).toMatchObject({ exitCode: 0, stderr: "" });
    expect(second).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await sha256(tarball)).toBe(before);
  }, 30_000);

  it.each([
    { args: ["--tarball"], label: "a missing tarball value" },
    {
      args: ["--tarball", "one.tgz", "two.tgz"],
      label: "a second tarball value",
    },
    { args: ["--unknown"], label: "an unknown option" },
  ])("rejects $label", async ({ args }) => {
    const fixtureRoot = await createFixture();
    const result = await runVerifier(fixtureRoot, args);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Usage:");
  });

  it("rejects a supplied tarball path that is not an existing regular .tgz file", async () => {
    const fixtureRoot = await createFixture();
    const wrongExtension = resolve(fixtureRoot, "package.tar");
    await writeFile(wrongExtension, "not a tarball", "utf8");

    const wrong = await runVerifier(fixtureRoot, ["--tarball", wrongExtension]);
    const missing = await runVerifier(fixtureRoot, [
      "--tarball",
      resolve(fixtureRoot, "missing.tgz"),
    ]);
    const directory = await runVerifier(fixtureRoot, [
      "--tarball",
      fixtureRoot,
    ]);

    expect(wrong.exitCode).not.toBe(0);
    expect(missing.exitCode).not.toBe(0);
    expect(directory.exitCode).not.toBe(0);
  });

  it.each([
    ["package/src/index.ts", "source"],
    ["package/test/package.test.js", "tests"],
    ["package/plugins/github-stars-mcp/.env", "environment state"],
    ["package/dist/state.sqlite3", "database state"],
    ["package/dist/state.sqlite3-journal", "database journal state"],
    ["package/dist/state.sqlite3.bak", "database backup state"],
    ["package/dist/cache.sqlite-wal.bak", "database sidecar backup state"],
    [
      "package/plugins/github-stars-mcp/state.db-journal.copy",
      "plugin database sidecar copy",
    ],
    ["package/dist/data.sqlite3.backup~", "database backup tilde state"],
    ["package/unexpected.txt", "an extra top-level file"],
  ])("rejects packed %s as %s", async (path) => {
    const fixtureRoot = await createFixture();
    const tarball = await writeHostileTarball(path);

    const result = await runVerifier(fixtureRoot, ["--tarball", tarball]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/unexpected|forbidden/iu);
  });

  it.each([
    ["../outside", "traversal"],
    ["/absolute", "absolute"],
    ["package\\dist\\cli.js", "backslash"],
    ["C:/outside", "drive-qualified"],
  ])("rejects a %s archive path", async (path, label) => {
    const fixtureRoot = await createFixture();
    const tarball = await writeHostileTarball(path);

    const result = await runVerifier(fixtureRoot, ["--tarball", tarball]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(label);
  });

  it("rejects symlink entries before installation", async () => {
    const fixtureRoot = await createFixture();
    const tarball = await writeHostileTarball("package/dist/cli.js", "symlink");

    const result = await runVerifier(fixtureRoot, ["--tarball", tarball]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("symlink");
  });

  it("rejects an overlong archive path before further parsing", async () => {
    const fixtureRoot = await createFixture();
    const tarball = await writeHostileTarball(`package/${"a".repeat(4097)}`);

    const result = await runVerifier(fixtureRoot, ["--tarball", tarball]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("path length limit");
  });

  it("rejects a CLI with a shebang suffix", async () => {
    const fixtureRoot = await createFixture(
      fixtureCli.replace(
        "#!/usr/bin/env node\n",
        "#!/usr/bin/env nodeBROKEN\n",
      ),
    );
    const tarball = await packFixture(fixtureRoot);

    const result = await runVerifier(fixtureRoot, ["--tarball", tarball]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("portable Node shebang");
  });

  it.each([
    [".mcp.json", "package/plugins/github-stars-mcp/.mcp.json"],
    [
      "skills/manage-github-stars/SKILL.md",
      "package/plugins/github-stars-mcp/skills/manage-github-stars/SKILL.md",
    ],
    ["assets/icon.png", "package/plugins/github-stars-mcp/assets/icon.png"],
    ["assets/logo.png", "package/plugins/github-stars-mcp/assets/logo.png"],
  ])("rejects a plugin missing %s", async (relativePath, archivePath) => {
    const fixtureRoot = await createFixture();
    await rm(resolve(fixtureRoot, "plugins/github-stars-mcp", relativePath));
    const tarball = await packFixture(fixtureRoot);

    const result = await runVerifier(fixtureRoot, ["--tarball", tarball]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(archivePath);
  });

  it("removes its private temporary root after a command failure", async () => {
    const fixtureRoot = await createFixture();
    const tarball = await packFixture(fixtureRoot);
    const verifier = await loadVerifier();
    const rootsBefore = new Set(
      (await readdir(tmpdir()))
        .filter((name) => name.startsWith("github-stars-package-verify-"))
        .sort(),
    );
    const runner: CommandRunner = async (command, args, options) => {
      if (args.includes("install")) {
        throw new Error("injected install failure");
      }
      return verifier.defaultRunCommand(command, args, options);
    };

    await expect(
      verifier.verifyPackage({
        args: ["--tarball", tarball],
        cwd: fixtureRoot,
        runCommand: runner,
      }),
    ).rejects.toThrow("injected install failure");

    const rootsAfter = (await readdir(tmpdir()))
      .filter((name) => name.startsWith("github-stars-package-verify-"))
      .sort();
    expect(rootsAfter).toEqual([...rootsBefore]);
  });

  it("rejects an oversized file generated in the installed package", async () => {
    const fixtureRoot = await createFixture();
    const tarball = await packFixture(fixtureRoot);
    const verifier = await loadVerifier();
    const runner: CommandRunner = async (command, args, options) => {
      const result = await verifier.defaultRunCommand(command, args, options);
      if (args.includes("install")) {
        const oversizedPath = resolve(
          options.cwd,
          "node_modules/github-stars-mcp/dist/generated.js",
        );
        const file = await open(oversizedPath, "wx");
        try {
          await file.truncate(32 * 1024 * 1024 + 1);
        } finally {
          await file.close();
        }
      }
      return result;
    };

    await expect(
      verifier.verifyPackage({
        args: ["--tarball", tarball],
        cwd: fixtureRoot,
        runCommand: runner,
      }),
    ).rejects.toThrow("installed package file exceeds the size limit");
  }, 30_000);

  it("bounds child shutdown after an output safety failure", async () => {
    const verifier = await loadVerifier();
    const startedAt = Date.now();
    const childSource = `
process.on("SIGTERM", () => {});
process.stdout.write("x".repeat(1024 * 1024 + 1));
setInterval(() => {}, 1000);
`;

    await expect(
      verifier.defaultRunCommand(process.execPath, ["-e", childSource], {
        cwd: repositoryRoot,
        env: sanitizedEnvironment(),
        expectedExitCodes: [0],
      }),
    ).rejects.toThrow("output safety limit");
    expect(Date.now() - startedAt).toBeLessThan(12_000);
  }, 15_000);

  it.runIf(process.platform === "win32")(
    "terminates a Windows child process tree after an output failure",
    async () => {
      const fixtureRoot = await createFixture();
      const marker = resolve(fixtureRoot, "grandchild-survived");
      const verifier = await loadVerifier();
      const grandchildSource = `
setTimeout(() => {
  require("node:fs").writeFileSync(process.argv[1], "survived");
}, 1500);
setTimeout(() => process.exit(0), 2000);
`;
      const parentSource = `
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}, process.argv[1]], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
grandchild.unref();
process.stdout.write("x".repeat(1024 * 1024 + 1));
setInterval(() => {}, 1000);
`;

      await expect(
        verifier.defaultRunCommand(
          process.execPath,
          ["-e", parentSource, marker],
          {
            cwd: fixtureRoot,
            env: sanitizedEnvironment(),
            expectedExitCodes: [0],
          },
        ),
      ).rejects.toThrow("output safety limit");
      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 2500);
      });
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
    15_000,
  );

  it("executes the installed npm binary shim", async () => {
    const fixtureRoot = await createFixture();
    const tarball = await packFixture(fixtureRoot);
    const verifier = await loadVerifier();
    const runner: CommandRunner = async (command, args, options) => {
      const result = await verifier.defaultRunCommand(command, args, options);
      if (args.includes("install")) {
        const shim = resolve(
          options.cwd,
          "node_modules/.bin",
          process.platform === "win32"
            ? "github-stars-mcp.cmd"
            : "github-stars-mcp",
        );
        await rm(shim, { force: true });
        await writeFile(
          shim,
          process.platform === "win32"
            ? "@exit /b 7\r\n"
            : "#!/bin/sh\nexit 7\n",
          "utf8",
        );
        if (process.platform !== "win32") await chmod(shim, 0o755);
      }
      return result;
    };

    await expect(
      verifier.verifyPackage({
        args: ["--tarball", tarball],
        cwd: fixtureRoot,
        runCommand: runner,
      }),
    ).rejects.toThrow(/(?:required child process failed|npm binary shim)/u);
  }, 30_000);

  it.each([
    ["GitHub", `ghp_${"A".repeat(36)}`],
    ["npm", `npm_${"B".repeat(36)}`],
  ])(
    "rejects %s token-like output from the installed binary",
    async (_kind, token) => {
      const fixtureRoot = await createFixture(
        fixtureCli.replace(
          'process.stdout.write("github-stars-mcp - AI-native Star management\\n");',
          `process.stdout.write("github-stars-mcp ${token}\\n");`,
        ),
      );
      const tarball = await packFixture(fixtureRoot);

      const result = await runVerifier(fixtureRoot, ["--tarball", tarball]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("token-like");
      expect(result.stderr).not.toContain(token);
    },
    30_000,
  );
});
