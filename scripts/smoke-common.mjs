import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const EXPECTED_TOOL_NAMES = Object.freeze([
  "github_stars_status",
  "github_stars_sync",
  "github_stars_query",
  "github_lists_query",
  "github_repositories_discover",
  "github_repositories_candidates",
  "github_changes_plan",
  "github_changes_inspect",
  "github_changes_apply",
  "github_changes_rollback",
]);

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;

function commandError(label, code, stdout, stderr) {
  const error = new Error(`${label} failed with exit code ${String(code)}`);
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

export function run(
  command,
  arguments_,
  {
    cwd = REPOSITORY_ROOT,
    env = process.env,
    label = command,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, arguments_, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        rejectPromise(new Error(`${label} timed out`));
      }
    }, timeoutMs);
    const append = (current, chunk, stream) => {
      const next = current + chunk;
      if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
        child.kill();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rejectPromise(new Error(`${label} ${stream} exceeded the limit`));
        }
      }
      return next;
    };
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout = append(stdout, chunk, "stdout");
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr = append(stderr, chunk, "stderr");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectPromise(new Error(`${label} could not start`, { cause: error }));
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        rejectPromise(commandError(label, code, stdout, stderr));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

export function parseJsonDocument(source, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} did not emit one JSON document`, {
      cause: error,
    });
  }
}

function npmCommand() {
  const npmExecPath = process.env.npm_execpath;
  if (
    typeof npmExecPath === "string" &&
    npmExecPath.length > 0 &&
    isAbsolute(npmExecPath)
  ) {
    return Object.freeze({
      command: process.execPath,
      prefix: [npmExecPath],
    });
  }
  return Object.freeze({
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    prefix: [],
  });
}

function isInside(root, path) {
  const fromRoot = relative(root, path);
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !fromRoot.startsWith("../") &&
    !fromRoot.startsWith("..\\")
  );
}

async function requireRegularFile(path, label) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    throw new Error(`${label} is missing`, { cause: error });
  }
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file`);
}

export async function createPackedInstallation({
  installInspector = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "github-stars-mcp-packed-"));
  const packRoot = join(root, "pack");
  const installRoot = join(root, "install");
  const stateRoot = join(root, "state");
  try {
    await Promise.all([
      mkdir(packRoot, { recursive: true }),
      mkdir(installRoot, { recursive: true }),
      mkdir(stateRoot, { recursive: true }),
    ]);
    await writeFile(
      join(installRoot, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
      "utf8",
    );
    const npm = npmCommand();
    const packed = await run(
      npm.command,
      [...npm.prefix, "pack", "--json", "--pack-destination", packRoot],
      { cwd: REPOSITORY_ROOT, label: "npm pack" },
    );
    const packResult = parseJsonDocument(packed.stdout, "npm pack");
    if (
      !Array.isArray(packResult) ||
      packResult.length !== 1 ||
      typeof packResult[0]?.filename !== "string"
    ) {
      throw new Error("npm pack returned an unexpected manifest");
    }
    const tarball = resolve(packRoot, packResult[0].filename);
    if (!isInside(packRoot, tarball)) {
      throw new Error("npm pack returned a path outside the pack directory");
    }
    await requireRegularFile(tarball, "packed tarball");

    const installArguments = [
      ...npm.prefix,
      "install",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      tarball,
    ];
    if (installInspector) {
      installArguments.push("@modelcontextprotocol/inspector@0.22.0");
    }
    await run(npm.command, installArguments, {
      cwd: installRoot,
      label: "packed package installation",
    });

    const installedPackageRoot = await realpath(
      join(installRoot, "node_modules/github-stars-mcp"),
    );
    const cliPath = join(installedPackageRoot, "dist/cli.js");
    await requireRegularFile(cliPath, "installed CLI");
    return Object.freeze({
      root,
      packRoot,
      installRoot,
      stateRoot,
      tarball,
      installedPackageRoot,
      cliPath,
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function regularFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function findCodexCommand() {
  const pathEntries = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0);
  for (const directory of pathEntries) {
    if (process.platform === "win32") {
      const executable = join(directory, "codex.exe");
      if (await regularFile(executable)) {
        return Object.freeze({ command: executable, prefix: [] });
      }
      const npmEntry = join(
        directory,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      );
      if (await regularFile(npmEntry)) {
        return Object.freeze({ command: process.execPath, prefix: [npmEntry] });
      }
      continue;
    }
    const executable = join(directory, "codex");
    if (await regularFile(executable)) {
      return Object.freeze({ command: executable, prefix: [] });
    }
  }
  return null;
}

export function isolatedCodexEnvironment(home) {
  const environment = {
    ...process.env,
    CODEX_HOME: home,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(home, "xdg-cache"),
    XDG_CONFIG_HOME: join(home, "xdg-config"),
    XDG_DATA_HOME: join(home, "xdg-data"),
    XDG_RUNTIME_DIR: join(home, "xdg-runtime"),
    XDG_STATE_HOME: join(home, "xdg-state"),
  };
  for (const key of [
    "CODEX_API_KEY",
    "GITHUB_STARS_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "OPENAI_API_KEY",
  ]) {
    delete environment[key];
  }
  return environment;
}

export async function removePackedInstallation(installation) {
  await rm(installation.root, { recursive: true, force: true });
}

export async function readJson(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${label} is unreadable`, { cause: error });
  }
  return parseJsonDocument(source, label);
}
