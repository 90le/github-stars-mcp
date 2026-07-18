import { createHash, randomUUID } from "node:crypto";
import { constants as fileSystemConstants } from "node:fs";
import { link, lstat, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function fail(message) {
  throw new Error(message);
}

function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function optionalLstat(path, options) {
  try {
    return await lstat(path, options);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function sameOpenedFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function samePathFile(left, right) {
  if (process.platform === "win32") {
    return (
      left.ino === right.ino &&
      left.size === right.size &&
      left.birthtimeNs === right.birthtimeNs &&
      left.mtimeNs === right.mtimeNs
    );
  }
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function pathMatchesOpenedFile(pathMetadata, openedMetadata) {
  if (process.platform === "win32") {
    return (
      pathMetadata.ino === openedMetadata.ino &&
      pathMetadata.size === openedMetadata.size &&
      pathMetadata.birthtimeNs === openedMetadata.birthtimeNs &&
      pathMetadata.mtimeNs === openedMetadata.mtimeNs
    );
  }
  return (
    pathMetadata.dev === openedMetadata.dev &&
    pathMetadata.ino === openedMetadata.ino
  );
}

function fileIdentity(metadata) {
  return process.platform === "win32"
    ? `${metadata.ino}`
    : `${metadata.dev}:${metadata.ino}`;
}

async function digestRegularFile(path, expectedMetadata) {
  const noFollow =
    typeof fileSystemConstants.O_NOFOLLOW === "number"
      ? fileSystemConstants.O_NOFOLLOW
      : 0;
  const handle = await open(path, fileSystemConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !pathMatchesOpenedFile(expectedMetadata, before)) {
      fail("checksum input identity changed before reading");
    }
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk);
    const after = await handle.stat({ bigint: true });
    if (!sameOpenedFile(before, after)) {
      fail("checksum input changed while it was being read");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function revalidateChecksumInput(file) {
  const metadata = await optionalLstat(file.canonical, { bigint: true });
  if (
    metadata === undefined ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    !samePathFile(file.metadata, metadata)
  ) {
    fail("checksum input changed after it was read");
  }
  const canonical = await realpath(file.canonical);
  if (!samePath(canonical, file.canonical)) {
    fail("checksum input path changed after it was read");
  }
}

async function writeNewChecksumFile(outputPath, contents) {
  const parentPath = dirname(outputPath);
  const parentMetadata = await optionalLstat(parentPath);
  if (
    parentMetadata === undefined ||
    parentMetadata.isSymbolicLink() ||
    !parentMetadata.isDirectory()
  ) {
    fail("checksum output parent must be a real directory");
  }
  const canonicalParent = await realpath(parentPath);
  if (!samePath(canonicalParent, parentPath)) {
    fail("checksum output parent must not traverse a symbolic link");
  }
  if ((await optionalLstat(outputPath)) !== undefined) {
    fail("checksum output already exists");
  }

  const temporaryPath = resolve(
    canonicalParent,
    `.${basename(outputPath)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, outputPath);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function writeChecksums(paths, options = {}) {
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.some((path) => typeof path !== "string" || path.length === 0)
  ) {
    fail("at least one exact release artifact path is required");
  }
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    fail("checksum options must be an object");
  }

  const outputPath = resolve(options.outputPath ?? "SHA256SUMS");
  const files = [];
  const canonicalPaths = new Set();
  const identities = new Set();
  const basenames = new Set();
  for (const path of paths) {
    if (
      path.includes("\0") ||
      !/\.(?:json|tgz)$/u.test(path) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(basename(path))
    ) {
      fail("checksum inputs must be exact .tgz or .json artifact paths");
    }
    const inputPath = resolve(path);
    const metadata = await optionalLstat(inputPath, { bigint: true });
    if (
      metadata === undefined ||
      metadata.isSymbolicLink() ||
      !metadata.isFile()
    ) {
      fail("checksum inputs must be existing regular files");
    }
    const canonical = await realpath(inputPath);
    if (!samePath(canonical, inputPath)) {
      fail("checksum inputs must not traverse symbolic links");
    }
    const name = basename(canonical);
    const identity = fileIdentity(metadata);
    if (
      canonical === outputPath ||
      canonicalPaths.has(canonical) ||
      identities.has(identity) ||
      basenames.has(name)
    ) {
      fail("checksum inputs must be unique files with unique basenames");
    }
    canonicalPaths.add(canonical);
    identities.add(identity);
    basenames.add(name);
    files.push({ canonical, metadata, name });
  }

  files.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const lines = [];
  for (const file of files) {
    const digest = await digestRegularFile(file.canonical, file.metadata);
    await revalidateChecksumInput(file);
    lines.push(`${digest}  ${file.name}`);
  }
  await writeNewChecksumFile(outputPath, `${lines.join("\n")}\n`);
  return Object.freeze({
    outputPath,
    files: Object.freeze(files.map(({ canonical }) => canonical)),
    lines: Object.freeze(lines),
  });
}

async function main() {
  const result = await writeChecksums(process.argv.slice(2));
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      files: result.files.length,
      output: result.outputPath,
    })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `Checksum generation failed: ${
        error instanceof Error ? error.message : "unknown failure"
      }\n`,
    );
    process.exitCode = 1;
  }
}
