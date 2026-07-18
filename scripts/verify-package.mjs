/* global Buffer, console, process, setTimeout, clearTimeout */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fileSystemConstants,
  createReadStream,
  existsSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { Transform } from "node:stream";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";

import { extract } from "tar-stream";

const USAGE =
  "Usage: node scripts/verify-package.mjs [--tarball <exact-package.tgz>]";
const PACKAGE_NAME = "github-stars-mcp";
const PACKAGE_ROOT = "package/";
const PLUGIN_ROOT = "plugins/github-stars-mcp";
const ARCHIVE_PLUGIN_ROOT = `${PACKAGE_ROOT}${PLUGIN_ROOT}`;
const REQUIRED_ARCHIVE_FILES = Object.freeze([
  "package/LICENSE",
  "package/README.md",
  "package/SECURITY.md",
  "package/dist/cli.js",
  "package/npm-shrinkwrap.json",
  "package/package.json",
  "package/plugins/github-stars-mcp/.codex-plugin/plugin.json",
  "package/plugins/github-stars-mcp/.mcp.json",
  "package/plugins/github-stars-mcp/assets/icon.png",
  "package/plugins/github-stars-mcp/assets/logo.png",
  "package/plugins/github-stars-mcp/skills/manage-github-stars/SKILL.md",
]);
const REQUIRED_DOCTOR_CHECKS = Object.freeze([
  "runtime",
  "database",
  "gh",
  "credentials",
  "network",
  "capabilities",
]);
const METADATA_FILES = new Set([
  "package/LICENSE",
  "package/README.md",
  "package/SECURITY.md",
  "package/npm-shrinkwrap.json",
  "package/package.json",
]);
const ALLOWED_DIRECTORY_ROOTS = Object.freeze([
  "package/dist",
  ARCHIVE_PLUGIN_ROOT,
]);
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 5_000;
const MAX_ARCHIVE_STREAM_BYTES = MAX_ARCHIVE_BYTES + MAX_ENTRIES * 2048 + 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_TERMINATION_GRACE_MS = 1_000;
const COMMAND_TERMINATION_LIMIT_MS = 10_000;
const TOKEN_LITERAL =
  /(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]{16,}|npm_[A-Za-z0-9]{20,})/iu;
const TOKEN_ASSIGNMENT =
  /\b(?:GITHUB_STARS_TOKEN|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN)\b\s*[:=]\s*\S+/iu;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const FORBIDDEN_PATH_SEGMENTS = new Set([
  ".git",
  ".github",
  "__tests__",
  "coverage",
  "fixture",
  "fixtures",
  "source",
  "src",
  "test",
  "tests",
]);
const LIFECYCLE_SCRIPTS = Object.freeze([
  "prepack",
  "postpack",
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "prepublishOnly",
  "prepare",
]);
const SENSITIVE_ENVIRONMENT_NAMES = Object.freeze([
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
]);
const SENSITIVE_ENVIRONMENT_KEYS = new Set(
  SENSITIVE_ENVIRONMENT_NAMES.map((name) => name.toUpperCase()),
);

class PackageVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackageVerificationError";
  }
}

function fail(message) {
  throw new PackageVerificationError(message);
}

function sameFileIdentity(left, right) {
  return (
    left.ino === right.ino &&
    (process.platform === "win32" || left.dev === right.dev)
  );
}

function parseArguments(args) {
  if (args.length === 0) return Object.freeze({ mode: "packed" });
  if (
    args.length !== 2 ||
    args[0] !== "--tarball" ||
    typeof args[1] !== "string" ||
    args[1].length === 0 ||
    args[1].includes("\0")
  ) {
    fail(USAGE);
  }
  return Object.freeze({ mode: "supplied", value: args[1] });
}

function sanitizedEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    const normalized = name.toUpperCase();
    if (
      SENSITIVE_ENVIRONMENT_KEYS.has(normalized) ||
      normalized.startsWith("NPM_CONFIG_") ||
      normalized.startsWith("NPM_LIFECYCLE_") ||
      normalized.startsWith("NPM_PACKAGE_") ||
      normalized.startsWith("GITHUB_STARS_MCP_") ||
      normalized === "GITHUB_HOST" ||
      normalized === "INIT_CWD" ||
      normalized === "OLDPWD" ||
      normalized === "PWD"
    ) {
      delete environment[name];
    }
  }
  return { ...environment, ...overrides };
}

async function createNpmEnvironment(temporaryRoot) {
  const userConfig = resolve(temporaryRoot, "user.npmrc");
  const globalConfig = resolve(temporaryRoot, "global.npmrc");
  const config = `registry=https://registry.npmjs.org/
audit=false
fund=false
ignore-scripts=false
update-notifier=false
`;
  await Promise.all([
    writeFile(userConfig, config, { encoding: "utf8", flag: "wx" }),
    writeFile(globalConfig, config, { encoding: "utf8", flag: "wx" }),
  ]);
  return sanitizedEnvironment({
    NPM_CONFIG_CACHE: resolve(temporaryRoot, "npm-cache"),
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    NPM_CONFIG_USERCONFIG: userConfig,
  });
}

function npmInvocation() {
  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    resolve(
      dirname(process.execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    ),
    process.env.APPDATA === undefined
      ? undefined
      : resolve(process.env.APPDATA, "npm/node_modules/npm/bin/npm-cli.js"),
  ];
  const npmCli = candidates.find(
    (candidate) =>
      typeof candidate === "string" &&
      isAbsolute(candidate) &&
      existsSync(candidate),
  );
  if (npmCli !== undefined) {
    return Object.freeze({
      argsPrefix: Object.freeze([npmCli]),
      command: process.execPath,
    });
  }
  if (process.platform === "win32") {
    fail(
      "npm CLI could not be located safely; run package verification through npm.",
    );
  }
  return Object.freeze({ argsPrefix: Object.freeze([]), command: "npm" });
}

function assertNoTokenLikeOutput(...values) {
  if (
    values.some(
      (value) => TOKEN_LITERAL.test(value) || TOKEN_ASSIGNMENT.test(value),
    )
  ) {
    fail("A child process emitted token-like output; details were redacted.");
  }
}

function signalProcessTree(child, signal) {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child when the process group is gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The bounded settlement timer handles an already-gone or unkillable child.
  }
}

function forceWindowsProcessTree(child) {
  return new Promise((resolvePromise) => {
    if (child.pid === undefined) {
      resolvePromise();
      return;
    }
    const systemRoot = process.env.SystemRoot;
    const taskkill =
      typeof systemRoot === "string" && isAbsolute(systemRoot)
        ? resolve(systemRoot, "System32", "taskkill.exe")
        : undefined;
    if (taskkill === undefined || !existsSync(taskkill)) {
      signalProcessTree(child, "SIGKILL");
      resolvePromise();
      return;
    }
    const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    let complete = false;
    const finish = () => {
      if (complete) return;
      complete = true;
      resolvePromise();
    };
    killer.once("error", finish);
    killer.once("close", finish);
  });
}

export function defaultRunCommand(command, args, options) {
  const expectedExitCodes = options.expectedExitCodes ?? [0];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...options.env, PWD: options.cwd },
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: options.windowsVerbatimArguments === true,
      windowsHide: true,
    });
    let settled = false;
    let stderr = "";
    let stdout = "";
    let outputBytes = 0;
    let forceTermination;
    let forcedSettlement;
    let pendingError;
    let terminationPromise;
    let timeout;

    const clearCommandTimers = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (forceTermination !== undefined) clearTimeout(forceTermination);
      if (forcedSettlement !== undefined) clearTimeout(forcedSettlement);
    };
    const settlePendingFailure = () => {
      if (settled || pendingError === undefined) return;
      settled = true;
      clearCommandTimers();
      reject(pendingError);
    };
    const requestFailure = (error, terminate = true) => {
      if (settled || pendingError !== undefined) return;
      pendingError = error;
      if (timeout !== undefined) clearTimeout(timeout);
      if (!terminate) {
        settlePendingFailure();
        return;
      }
      if (process.platform === "win32") {
        terminationPromise = forceWindowsProcessTree(child);
      } else {
        signalProcessTree(child, "SIGTERM");
        terminationPromise = new Promise((resolveTermination) => {
          forceTermination = setTimeout(() => {
            signalProcessTree(child, "SIGKILL");
            resolveTermination();
          }, COMMAND_TERMINATION_GRACE_MS);
        });
      }
      forcedSettlement = setTimeout(
        settlePendingFailure,
        COMMAND_TERMINATION_LIMIT_MS,
      );
      forcedSettlement.unref();
    };
    const append = (kind, chunk) => {
      if (settled || pendingError !== undefined) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        requestFailure(
          new PackageVerificationError(
            "A child process exceeded the output safety limit.",
          ),
        );
        return;
      }
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk) => {
      append("stdout", chunk);
    });
    child.stderr.on("data", (chunk) => {
      append("stderr", chunk);
    });
    child.once("error", (error) => {
      requestFailure(
        new PackageVerificationError(
          `A required child process could not start (${error.code ?? "error"}).`,
        ),
        false,
      );
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (pendingError !== undefined) {
        void (terminationPromise ?? Promise.resolve()).then(
          settlePendingFailure,
        );
        return;
      }
      settled = true;
      clearCommandTimers();
      try {
        assertNoTokenLikeOutput(stdout, stderr);
      } catch (error) {
        reject(error);
        return;
      }
      if (
        signal !== null ||
        code === null ||
        !expectedExitCodes.includes(code)
      ) {
        reject(
          new PackageVerificationError(
            `A required child process failed (exit=${String(code)}, signal=${String(signal)}).`,
          ),
        );
        return;
      }
      resolvePromise(Object.freeze({ exitCode: code, stderr, stdout }));
    });
    timeout = setTimeout(() => {
      requestFailure(
        new PackageVerificationError("A required child process timed out."),
      );
    }, COMMAND_TIMEOUT_MS);
    timeout.unref();
  });
}

async function assertRegularTarball(path) {
  if (!path.endsWith(".tgz")) {
    fail("The supplied tarball path must end in exact .tgz.");
  }
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    fail("The supplied tarball does not exist.");
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > MAX_ARCHIVE_BYTES
  ) {
    fail(
      "The supplied tarball must be a non-empty regular file within the size limit.",
    );
  }
}

async function sha256File(
  path,
  maximumBytes = Number.POSITIVE_INFINITY,
  expectedBytes,
) {
  const noFollow = fileSystemConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(path, fileSystemConstants.O_RDONLY | noFollow);
  } catch {
    fail("A file could not be opened as a regular non-symlink file.");
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) {
      fail("A file exceeded its verification size or type limit.");
    }
    if (expectedBytes !== undefined && before.size !== expectedBytes) {
      fail("A file changed size before it could be verified.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maximumBytes) {
        fail("A file exceeded its verification size limit.");
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (
      bytes !== before.size ||
      after.size !== before.size ||
      !sameFileIdentity(after, before)
    ) {
      fail("A file changed while it was being verified.");
    }
    let pathAfter;
    try {
      pathAfter = await lstat(path);
    } catch {
      fail("A verified file disappeared from its path.");
    }
    if (
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      !sameFileIdentity(pathAfter, before)
    ) {
      fail("A verified path changed identity or became a symlink.");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function copyAndHashRegularFile(source, destination, maximumBytes) {
  const noFollow = fileSystemConstants.O_NOFOLLOW ?? 0;
  let sourceHandle;
  try {
    sourceHandle = await open(source, fileSystemConstants.O_RDONLY | noFollow);
  } catch {
    fail("The supplied tarball could not be opened safely.");
  }
  let destinationHandle;
  try {
    destinationHandle = await open(destination, "wx", 0o600);
    const before = await sourceHandle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) {
      fail("The supplied tarball exceeds its size or type limit.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        buffer.length,
        null,
      );
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maximumBytes) {
        fail("The supplied tarball grew beyond the size limit.");
      }
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          null,
        );
        if (bytesWritten === 0) {
          fail("The private tarball copy could not be completed.");
        }
        written += bytesWritten;
      }
    }
    const after = await sourceHandle.stat();
    let pathAfter;
    try {
      pathAfter = await lstat(source);
    } catch {
      fail("The supplied tarball disappeared while it was copied.");
    }
    if (
      bytes !== before.size ||
      after.size !== before.size ||
      !sameFileIdentity(after, before) ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      !sameFileIdentity(pathAfter, before)
    ) {
      fail("The supplied tarball changed while it was copied.");
    }
    await destinationHandle.sync();
    return Object.freeze({
      digest: hash.digest("hex"),
      size: bytes,
    });
  } finally {
    await Promise.all([sourceHandle.close(), destinationHandle?.close()]);
  }
}

function assertSafeArchivePath(path) {
  if (path.length > 4096) {
    fail("Archive paths must not exceed the path length limit.");
  }
  if (path.includes("\\"))
    fail("Archive paths containing a backslash are unsafe.");
  if (/^[A-Za-z]:\//u.test(path)) {
    fail("Archive paths must not be drive-qualified.");
  }
  if (path.startsWith("/")) fail("Archive paths must not be absolute.");
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      fail("Archive paths must not contain control characters.");
    }
  }
  const segments = path.split("/");
  if (segments.includes("..")) fail("Archive path traversal is forbidden.");
  if (segments.some((segment) => segment.length === 0 || segment === ".")) {
    fail("Archive paths must be normalized.");
  }
  if (segments[0] !== "package") {
    fail("Every archive path must remain below package/.");
  }
}

function forbiddenPathReason(path) {
  const relativePath = path.slice(PACKAGE_ROOT.length);
  const segments = relativePath.toLowerCase().split("/");
  if (segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment))) {
    return "source or tests";
  }
  if (
    segments.some(
      (segment) => segment === ".env" || segment.startsWith(".env."),
    )
  ) {
    return "environment state";
  }
  const fileName = segments.at(-1) ?? "";
  if (
    /\.(?:db|sqlite|sqlite3)(?:(?:-(?:journal|shm|wal))|(?:\.(?:bak|backup|copy))|~)*$/u.test(
      fileName,
    ) ||
    fileName === "npm-debug.log"
  ) {
    return "database or local state";
  }
  return undefined;
}

function isBelow(path, root) {
  return path.startsWith(`${root}/`);
}

function isAllowedArchivePath(path, type) {
  const reason = forbiddenPathReason(path);
  if (reason !== undefined)
    fail(`Forbidden ${reason} was found in the package.`);
  if (type === "directory") {
    return (
      path === "package" ||
      path === "package/plugins" ||
      ALLOWED_DIRECTORY_ROOTS.some(
        (root) => path === root || isBelow(path, root) || isBelow(root, path),
      )
    );
  }
  return (
    METADATA_FILES.has(path) ||
    isBelow(path, "package/dist") ||
    isBelow(path, ARCHIVE_PLUGIN_ROOT)
  );
}

async function consumeEntry(stream, header, state) {
  const path = header.name;
  if (typeof path !== "string") fail("Archive entry names must be text.");
  assertSafeArchivePath(path);
  if (state.paths.has(path)) fail("Duplicate archive paths are forbidden.");
  state.paths.add(path);
  state.entryCount += 1;
  if (state.entryCount > MAX_ENTRIES) {
    fail("The archive contains too many entries.");
  }

  const type = header.type ?? "file";
  if (type === "symlink" || type === "link") {
    fail("Archive symlink and hardlink entries are forbidden.");
  }
  if (type !== "file" && type !== "directory") {
    fail(`Archive entry type ${String(type)} is forbidden.`);
  }
  if (!isAllowedArchivePath(path, type)) {
    fail("Unexpected packed file or directory.");
  }
  if (type === "directory") {
    for await (const chunk of stream) {
      if (chunk.length !== 0) fail("Archive directories must not carry data.");
    }
    state.directories.add(path);
    return;
  }

  if (
    typeof header.size !== "number" ||
    !Number.isSafeInteger(header.size) ||
    header.size < 0 ||
    header.size > MAX_ENTRY_BYTES
  ) {
    fail("Archive entry size is invalid or exceeds the safety limit.");
  }
  const hash = createHash("sha256");
  const captured = [];
  let bytes = 0;
  const shouldCapture =
    METADATA_FILES.has(path) ||
    path === "package/dist/cli.js" ||
    path === "package/plugins/github-stars-mcp/.codex-plugin/plugin.json" ||
    path === "package/plugins/github-stars-mcp/.mcp.json";
  for await (const chunk of stream) {
    bytes += chunk.length;
    state.totalBytes += chunk.length;
    if (bytes > MAX_ENTRY_BYTES || state.totalBytes > MAX_ARCHIVE_BYTES) {
      fail("Archive content exceeds the safety limit.");
    }
    hash.update(chunk);
    if (shouldCapture) captured.push(chunk);
  }
  if (bytes !== header.size)
    fail("Archive entry size does not match its header.");
  state.files.set(
    path,
    Object.freeze({
      content: shouldCapture ? Buffer.concat(captured) : undefined,
      digest: hash.digest("hex"),
      size: bytes,
    }),
  );
}

export async function inspectTarball(tarball) {
  await assertRegularTarball(tarball);
  const state = {
    directories: new Set(),
    entryCount: 0,
    files: new Map(),
    paths: new Set(),
    totalBytes: 0,
  };
  const archive = extract();
  let archiveStreamBytes = 0;
  const archiveLimit = new Transform({
    transform(chunk, _encoding, callback) {
      archiveStreamBytes += chunk.length;
      if (archiveStreamBytes > MAX_ARCHIVE_STREAM_BYTES) {
        callback(
          new PackageVerificationError(
            "The expanded archive exceeds the stream safety limit.",
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
  let entryFailure;
  archive.on("entry", (header, stream, next) => {
    void consumeEntry(stream, header, state).then(
      () => {
        next();
      },
      (error) => {
        entryFailure = error;
        archive.destroy(error);
      },
    );
  });

  await new Promise((resolvePromise, reject) => {
    const input = createReadStream(tarball);
    const gunzip = createGunzip();
    const failPipeline = (error) => {
      input.destroy();
      gunzip.destroy();
      archiveLimit.destroy();
      archive.destroy();
      reject(entryFailure ?? error);
    };
    input.once("error", failPipeline);
    gunzip.once("error", failPipeline);
    archiveLimit.once("error", failPipeline);
    archive.once("error", failPipeline);
    archive.once("finish", resolvePromise);
    input.pipe(gunzip).pipe(archiveLimit).pipe(archive);
  });

  for (const required of REQUIRED_ARCHIVE_FILES) {
    if (!state.files.has(required)) {
      fail(`Required package file is missing: ${required}.`);
    }
  }
  const manifest = parseJsonFile(
    state.files.get("package/package.json")?.content,
    "package.json",
  );
  const shrinkwrap = parseJsonFile(
    state.files.get("package/npm-shrinkwrap.json")?.content,
    "npm-shrinkwrap.json",
  );
  const pluginManifest = parseJsonFile(
    state.files.get(
      "package/plugins/github-stars-mcp/.codex-plugin/plugin.json",
    )?.content,
    "plugin.json",
  );
  const pluginMcp = parseJsonFile(
    state.files.get("package/plugins/github-stars-mcp/.mcp.json")?.content,
    ".mcp.json",
  );
  validateManifest(manifest);
  validateShrinkwrap(shrinkwrap, manifest);
  validatePluginManifest(pluginManifest, manifest);
  validatePluginMcp(pluginMcp, manifest);
  const cli = state.files.get("package/dist/cli.js")?.content;
  if (
    cli === undefined ||
    !cli.toString("utf8").startsWith("#!/usr/bin/env node\n")
  ) {
    fail("The installed CLI entry must start with the portable Node shebang.");
  }

  return Object.freeze({
    directories: Object.freeze([...state.directories].sort()),
    files: new Map(state.files),
    manifest: Object.freeze(manifest),
  });
}

function parseJsonFile(content, label) {
  if (
    content === undefined ||
    content.length === 0 ||
    content.length > 1024 * 1024
  ) {
    fail(`${label} is missing or exceeds the metadata limit.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    fail(`${label} must contain valid JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`${label} must contain a JSON object.`);
  }
  return parsed;
}

function validateDependencyMap(value, label) {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  for (const [name, version] of Object.entries(value)) {
    if (
      name.length === 0 ||
      typeof version !== "string" ||
      !SEMVER.test(version)
    ) {
      fail(`${label} must contain exact registry versions only.`);
    }
  }
}

function validateManifest(manifest) {
  if (manifest.name !== PACKAGE_NAME) fail("Package name does not match.");
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
    fail("Package version must be exact semantic version text.");
  }
  if (manifest.type !== "module") fail("The package must use ESM.");
  if (manifest.private !== false)
    fail("The distributable package must be public.");
  if (manifest.license !== "Apache-2.0") {
    fail("The package license must be Apache-2.0.");
  }
  if (
    typeof manifest.engines !== "object" ||
    manifest.engines === null ||
    manifest.engines.node !== ">=22"
  ) {
    fail("The package Node engine contract must be >=22.");
  }
  if (
    typeof manifest.bin !== "object" ||
    manifest.bin === null ||
    Array.isArray(manifest.bin) ||
    Object.keys(manifest.bin).length !== 1 ||
    manifest.bin[PACKAGE_NAME] !== "dist/cli.js"
  ) {
    fail("The package binary contract is invalid.");
  }
  if (
    !Array.isArray(manifest.files) ||
    !manifest.files.includes(PLUGIN_ROOT) ||
    manifest.files.includes("plugin")
  ) {
    fail("The package files contract must use the plural plugin path.");
  }
  if (
    manifest.scripts !== undefined &&
    (typeof manifest.scripts !== "object" ||
      manifest.scripts === null ||
      Array.isArray(manifest.scripts))
  ) {
    fail("Package scripts must be an object.");
  }
  for (const name of LIFECYCLE_SCRIPTS) {
    if (manifest.scripts?.[name] !== undefined) {
      fail("Install-time package lifecycle scripts are forbidden.");
    }
  }
  validateDependencyMap(manifest.dependencies, "dependencies");
  validateDependencyMap(manifest.optionalDependencies, "optionalDependencies");
}

function validateShrinkwrap(shrinkwrap, manifest) {
  if (
    shrinkwrap.name !== manifest.name ||
    shrinkwrap.version !== manifest.version ||
    shrinkwrap.lockfileVersion !== 3 ||
    shrinkwrap.requires !== true ||
    typeof shrinkwrap.packages !== "object" ||
    shrinkwrap.packages === null ||
    typeof shrinkwrap.packages[""] !== "object" ||
    shrinkwrap.packages[""] === null ||
    shrinkwrap.packages[""].name !== manifest.name ||
    shrinkwrap.packages[""].version !== manifest.version
  ) {
    fail("npm-shrinkwrap.json does not match the package manifest.");
  }
}

function validatePluginManifest(pluginManifest, manifest) {
  if (
    pluginManifest.name !== PACKAGE_NAME ||
    pluginManifest.version !== manifest.version ||
    pluginManifest.mcpServers !== "./.mcp.json" ||
    pluginManifest.skills !== "./skills/"
  ) {
    fail("The plugin manifest does not match the packaged plugin contract.");
  }
}

function validatePluginMcp(pluginMcp, manifest) {
  const servers = pluginMcp.mcpServers;
  if (
    typeof servers !== "object" ||
    servers === null ||
    Array.isArray(servers) ||
    Object.keys(servers).length !== 1
  ) {
    fail("The plugin MCP configuration must declare exactly one server.");
  }
  const server = servers[PACKAGE_NAME];
  const expectedArguments = [
    "-y",
    `${PACKAGE_NAME}@${manifest.version}`,
    "--stdio",
  ];
  if (
    typeof server !== "object" ||
    server === null ||
    Array.isArray(server) ||
    server.command !== "npx" ||
    !Array.isArray(server.args) ||
    !sameSortedValues(server.args, expectedArguments) ||
    server.args.join("\0") !== expectedArguments.join("\0")
  ) {
    fail("The plugin MCP launcher must pin the matching package version.");
  }
}

function archivePathForInstalled(relativePath) {
  return `${PACKAGE_ROOT}${relativePath.replaceAll(sep, "/")}`;
}

async function enumerateInstalledPackage(root) {
  const files = new Map();
  const directories = new Set();
  let entryCount = 0;
  let totalBytes = 0;

  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_ENTRIES) {
        fail("The installed package contains too many entries.");
      }
      const absolutePath = resolve(directory, entry.name);
      const relativePath =
        relativeDirectory.length === 0
          ? entry.name
          : `${relativeDirectory}/${entry.name}`;
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        fail("The installed package contains a symlink.");
      }
      const archivePath = archivePathForInstalled(relativePath);
      assertSafeArchivePath(archivePath);
      if (metadata.isDirectory()) {
        if (!isAllowedArchivePath(archivePath, "directory")) {
          fail("The installed package contains an unexpected directory.");
        }
        directories.add(archivePath);
        await visit(absolutePath, relativePath);
      } else if (metadata.isFile()) {
        if (!isAllowedArchivePath(archivePath, "file")) {
          fail("The installed package contains an unexpected file.");
        }
        if (metadata.size > MAX_ENTRY_BYTES) {
          fail("An installed package file exceeds the size limit.");
        }
        totalBytes += metadata.size;
        if (totalBytes > MAX_ARCHIVE_BYTES) {
          fail("The installed package exceeds the total size limit.");
        }
        files.set(
          archivePath,
          await sha256File(absolutePath, MAX_ENTRY_BYTES, metadata.size),
        );
      } else {
        fail("The installed package contains a non-regular entry.");
      }
    }
  }

  await visit(root, "");
  return Object.freeze({ directories, files });
}

function sameSortedValues(left, right) {
  const leftValues = [...left].sort();
  const rightValues = [...right].sort();
  return (
    leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index])
  );
}

function assertInstalledMatchesArchive(installed, inspected) {
  if (!sameSortedValues(installed.files.keys(), inspected.files.keys())) {
    fail("The installed package file tree differs from the verified archive.");
  }
  for (const [path, digest] of installed.files) {
    if (inspected.files.get(path)?.digest !== digest) {
      fail("An installed package file differs from the verified archive.");
    }
  }
}

async function assertArchiveMatchesSource(cwd, inspected) {
  for (const [archivePath, archiveFile] of inspected.files) {
    const relativePath = archivePath.slice(PACKAGE_ROOT.length);
    const sourcePath = resolve(cwd, ...relativePath.split("/"));
    const sourceRelative = relative(cwd, sourcePath);
    if (
      sourceRelative.length === 0 ||
      sourceRelative === ".." ||
      sourceRelative.startsWith(`..${sep}`) ||
      isAbsolute(sourceRelative)
    ) {
      fail("A packed file escapes the source tree.");
    }
    let metadata;
    try {
      metadata = await lstat(sourcePath);
    } catch {
      fail("A packed file is missing from the source tree.");
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail("Packed source files must be regular non-symlink files.");
    }
    if (
      metadata.size !== archiveFile.size ||
      (await sha256File(sourcePath, MAX_ENTRY_BYTES, metadata.size)) !==
        archiveFile.digest
    ) {
      fail("A packed file differs from the source tree.");
    }
  }
}

async function installedBinaryInvocation(installRoot, cli, cliMetadata) {
  const binRoot = resolve(installRoot, "node_modules", ".bin");
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    const commandInterpreter =
      typeof systemRoot === "string" && isAbsolute(systemRoot)
        ? resolve(systemRoot, "System32", "cmd.exe")
        : undefined;
    if (commandInterpreter === undefined || !existsSync(commandInterpreter)) {
      fail("The trusted Windows command interpreter is unavailable.");
    }
    const shim = resolve(binRoot, `${PACKAGE_NAME}.cmd`);
    const metadata = await lstat(shim);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size <= 0 ||
      metadata.size > 64 * 1024 ||
      /[%!^&|<>"\r\n]/u.test(shim)
    ) {
      fail("The installed npm binary shim is unsafe.");
    }
    return Object.freeze({
      command: commandInterpreter,
      shim,
      windows: true,
    });
  }

  if ((cliMetadata.mode & 0o111) === 0) {
    fail("The installed CLI target is not executable.");
  }
  const shim = resolve(binRoot, PACKAGE_NAME);
  const metadata = await lstat(shim);
  if (!metadata.isSymbolicLink() && !metadata.isFile()) {
    fail("The installed npm binary shim is missing.");
  }
  if ((await realpath(shim)) !== (await realpath(cli))) {
    fail("The installed npm binary shim does not target the packaged CLI.");
  }
  return Object.freeze({ command: shim, shim, windows: false });
}

async function runInstalledCli(invocation, args, options, runCommand) {
  if (!args.every((argument) => /^--[a-z][a-z0-9-]*$/u.test(argument))) {
    fail("The installed CLI probe contains an unsafe argument.");
  }
  const commandArguments = invocation.windows
    ? ["/d", "/v:off", "/s", "/c", `""${invocation.shim}" ${args.join(" ")}"`]
    : args;
  const result = await runCommand(invocation.command, commandArguments, {
    cwd: options.cwd,
    env: options.env,
    expectedExitCodes: options.expectedExitCodes,
    windowsVerbatimArguments: invocation.windows,
  });
  assertNoTokenLikeOutput(result.stdout, result.stderr);
  return result;
}

async function smokeInstalledPackage(installRoot, manifest, runCommand) {
  const packageRoot = resolve(installRoot, "node_modules", PACKAGE_NAME);
  const cli = resolve(packageRoot, manifest.bin[PACKAGE_NAME]);
  const cliMetadata = await lstat(cli);
  if (!cliMetadata.isFile() || cliMetadata.isSymbolicLink()) {
    fail("The installed binary target is not a regular file.");
  }
  const invocation = await installedBinaryInvocation(
    installRoot,
    cli,
    cliMetadata,
  );
  const baseEnvironment = sanitizedEnvironment();
  const help = await runInstalledCli(
    invocation,
    ["--help"],
    {
      cwd: installRoot,
      env: baseEnvironment,
      expectedExitCodes: [0],
    },
    runCommand,
  );
  if (help.stderr !== "" || !help.stdout.toLowerCase().includes(PACKAGE_NAME)) {
    fail("The installed binary --help contract failed.");
  }
  const version = await runInstalledCli(
    invocation,
    ["--version"],
    {
      cwd: installRoot,
      env: baseEnvironment,
      expectedExitCodes: [0],
    },
    runCommand,
  );
  if (version.stderr !== "" || version.stdout !== `${manifest.version}\n`) {
    fail("The installed binary --version contract failed.");
  }

  const doctorDataRoot = resolve(installRoot, "doctor-data");
  const doctorEnvironment = sanitizedEnvironment({
    GH_CONFIG_DIR: resolve(installRoot, "gh-config"),
    GITHUB_STARS_MCP_AUTH_MODE: "env",
    GITHUB_STARS_MCP_DATA_DIR: doctorDataRoot,
    GITHUB_STARS_MCP_READ_ONLY: "true",
  });
  const doctor = await runInstalledCli(
    invocation,
    ["--doctor", "--json"],
    {
      cwd: installRoot,
      env: doctorEnvironment,
      expectedExitCodes: [1],
    },
    runCommand,
  );
  if (doctor.stderr !== "") {
    fail("The installed binary doctor wrote unexpected stderr.");
  }
  let report;
  try {
    report = JSON.parse(doctor.stdout);
  } catch {
    fail("The installed binary doctor did not emit JSON.");
  }
  if (
    typeof report !== "object" ||
    report === null ||
    report.status !== "unusable" ||
    !Array.isArray(report.checks) ||
    !sameSortedValues(
      report.checks.map((check) => check?.name),
      REQUIRED_DOCTOR_CHECKS,
    ) ||
    report.checks.map((check) => check?.name).join("\0") !==
      REQUIRED_DOCTOR_CHECKS.join("\0")
  ) {
    fail("The installed binary doctor check contract failed.");
  }
}

async function packOnce(cwd, temporaryRoot, npmEnvironment, runCommand) {
  const packRoot = resolve(temporaryRoot, "pack");
  await mkdir(packRoot, { recursive: false });
  const invocation = npmInvocation();
  const result = await runCommand(
    invocation.command,
    [
      ...invocation.argsPrefix,
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packRoot,
    ],
    {
      cwd,
      env: npmEnvironment,
      expectedExitCodes: [0],
    },
  );
  assertNoTokenLikeOutput(result.stdout, result.stderr);
  let records;
  try {
    records = JSON.parse(result.stdout);
  } catch {
    fail("npm pack did not return valid JSON.");
  }
  if (
    !Array.isArray(records) ||
    records.length !== 1 ||
    typeof records[0]?.filename !== "string" ||
    records[0].filename.length === 0 ||
    basename(records[0].filename) !== records[0].filename ||
    !records[0].filename.endsWith(".tgz")
  ) {
    fail("npm pack must return exactly one safe .tgz filename.");
  }
  const entries = await readdir(packRoot);
  if (entries.length !== 1 || entries[0] !== records[0].filename) {
    fail("npm pack must create exactly the one reported tarball.");
  }
  return resolve(packRoot, records[0].filename);
}

async function installAndSmoke(
  temporaryRoot,
  tarball,
  inspected,
  npmEnvironment,
  runCommand,
) {
  const installRoot = resolve(temporaryRoot, "install");
  await mkdir(installRoot, { recursive: false });
  await writeFile(
    resolve(installRoot, "package.json"),
    '{"name":"github-stars-mcp-package-smoke","private":true}\n',
    "utf8",
  );
  const invocation = npmInvocation();
  const install = await runCommand(
    invocation.command,
    [
      ...invocation.argsPrefix,
      "install",
      "--ignore-scripts=false",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    {
      cwd: installRoot,
      env: npmEnvironment,
      expectedExitCodes: [0],
    },
  );
  assertNoTokenLikeOutput(install.stdout, install.stderr);
  const packageRoot = resolve(installRoot, "node_modules", PACKAGE_NAME);
  const packageMetadata = await lstat(packageRoot);
  if (!packageMetadata.isDirectory() || packageMetadata.isSymbolicLink()) {
    fail("npm did not install the verified package as a regular directory.");
  }
  const installed = await enumerateInstalledPackage(packageRoot);
  assertInstalledMatchesArchive(installed, inspected);
  await smokeInstalledPackage(installRoot, inspected.manifest, runCommand);
}

export async function verifyPackage(options = {}) {
  const args = options.args ?? process.argv.slice(2);
  const cwd = resolve(options.cwd ?? process.cwd());
  const runCommand = options.runCommand ?? defaultRunCommand;
  const parsed = parseArguments(args);
  const temporaryRoot = await mkdtemp(
    resolve(tmpdir(), "github-stars-package-verify-"),
  );
  let packInvocations = 0;
  try {
    const npmEnvironment = await createNpmEnvironment(temporaryRoot);
    let originalDigest;
    let originalSize;
    let originalTarball;
    let verificationTarball;
    if (parsed.mode === "supplied") {
      originalTarball = resolve(cwd, parsed.value);
      await assertRegularTarball(originalTarball);
      verificationTarball = resolve(temporaryRoot, "supplied-package.tgz");
      const copied = await copyAndHashRegularFile(
        originalTarball,
        verificationTarball,
        MAX_ARCHIVE_BYTES,
      );
      originalDigest = copied.digest;
      originalSize = copied.size;
      if (
        (await sha256File(
          verificationTarball,
          MAX_ARCHIVE_BYTES,
          copied.size,
        )) !== originalDigest
      ) {
        fail(
          "The private verification copy does not match the supplied tarball.",
        );
      }
    } else {
      packInvocations += 1;
      verificationTarball = await packOnce(
        cwd,
        temporaryRoot,
        npmEnvironment,
        runCommand,
      );
      originalTarball = verificationTarball;
    }
    const inspected = await inspectTarball(verificationTarball);
    await assertArchiveMatchesSource(cwd, inspected);
    await installAndSmoke(
      temporaryRoot,
      verificationTarball,
      inspected,
      npmEnvironment,
      runCommand,
    );
    if (
      parsed.mode === "supplied" &&
      (await sha256File(originalTarball, MAX_ARCHIVE_BYTES, originalSize)) !==
        originalDigest
    ) {
      fail("The supplied tarball changed during verification.");
    }
    return Object.freeze({
      fileCount: inspected.files.size,
      mode: parsed.mode,
      packInvocations,
      tarball: originalTarball,
    });
  } finally {
    await rm(temporaryRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }
}

async function main() {
  try {
    const result = await verifyPackage();
    console.log(
      `Package verification passed: mode=${result.mode}, files=${result.fileCount}.`,
    );
    return 0;
  } catch (error) {
    const message =
      error instanceof PackageVerificationError
        ? error.message
        : "Unexpected package verification failure.";
    const safeMessage =
      TOKEN_LITERAL.test(message) || TOKEN_ASSIGNMENT.test(message)
        ? "Sensitive failure details were redacted."
        : message;
    console.error(`Package verification failed: ${safeMessage}`);
    return 1;
  }
}

const entryPath = process.argv[1];
if (
  typeof entryPath === "string" &&
  import.meta.url === pathToFileURL(entryPath).href
) {
  process.exitCode = await main();
}
