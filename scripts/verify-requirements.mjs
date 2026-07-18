import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";

const SPEC_PATH =
  "docs/superpowers/specs/2026-07-16-github-stars-mcp-design.md";
const MATRIX_PATH = "docs/verification-matrix.md";
const ARTIFACT_PATH = "artifacts/requirements.json";
const REPOSITORY_ROOT = await realpath(resolve("."));

function fail(message) {
  throw new Error(message);
}

function parseArguments(arguments_) {
  if (arguments_.length === 0) return false;
  if (arguments_.length === 1 && arguments_[0] === "--release") return true;
  fail("usage: verify-requirements.mjs [--release]");
}

function requirementIds(spec) {
  const ids = [...spec.matchAll(/\*\*([A-Z]+-\d+):\*\*/gu)].map(
    (match) => match[1],
  );
  if (
    ids.length !== 80 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => id === undefined)
  ) {
    fail("approved specification must contain 80 unique requirement IDs");
  }
  return ids;
}

function backtickPath(value, id, column) {
  const match = /^`([^`]+)`$/u.exec(value);
  if (match?.[1] === undefined) {
    fail(`${id} ${column} evidence must be one backtick-quoted path`);
  }
  return match[1];
}

function matrixRows(matrix) {
  const expectedHeader =
    "| Requirement | Implementation evidence | Verification evidence | Status |\n" +
    "|---|---|---|---|";
  if (!matrix.includes(expectedHeader)) {
    fail("verification matrix has an invalid table header");
  }
  const rows = [];
  for (const line of matrix.split(/\r?\n/u)) {
    if (!/^\|\s*[A-Z]+-\d+\s*\|/u.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 4) fail("verification matrix row has invalid columns");
    const [id, implementationCell, verificationCell, status] = cells;
    if (
      id === undefined ||
      implementationCell === undefined ||
      verificationCell === undefined ||
      status === undefined ||
      !/^[A-Z]+-\d+$/u.test(id)
    ) {
      fail("verification matrix row is malformed");
    }
    rows.push(
      Object.freeze({
        id,
        implementation: backtickPath(implementationCell, id, "implementation"),
        verification: backtickPath(verificationCell, id, "verification"),
        status,
      }),
    );
  }
  return rows;
}

function insideRepository(path) {
  const fromRoot = relative(REPOSITORY_ROOT, path);
  return (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

async function verifyEvidencePath(path, id, column) {
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    fail(`${id} ${column} evidence path is not repository-relative`);
  }
  const resolved = resolve(REPOSITORY_ROOT, path);
  if (!insideRepository(resolved)) {
    fail(`${id} ${column} evidence escapes the repository`);
  }
  let metadata;
  try {
    metadata = await lstat(resolved);
  } catch {
    fail(`${id} ${column} evidence path does not exist: ${path}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${id} ${column} evidence must be a regular file: ${path}`);
  }
  const canonical = await realpath(resolved);
  if (!insideRepository(canonical) || !(await stat(canonical)).isFile()) {
    fail(`${id} ${column} evidence has an invalid canonical path`);
  }
}

export async function verifyRequirements({ releaseMode = false } = {}) {
  const [spec, matrix] = await Promise.all([
    readFile(SPEC_PATH, "utf8"),
    readFile(MATRIX_PATH, "utf8"),
  ]);
  const ids = requirementIds(spec);
  const rows = matrixRows(matrix);
  const byId = new Map();
  for (const row of rows) {
    if (byId.has(row.id)) fail(`duplicate verification row: ${row.id}`);
    byId.set(row.id, row);
  }
  if (rows.length !== ids.length) {
    fail("verification matrix must contain exactly 80 rows");
  }
  for (const id of ids) {
    const row = byId.get(id);
    if (row === undefined) fail(`missing verification row: ${id}`);
    if (releaseMode && row.status !== "Verified") {
      fail(`${id} is not Verified in release mode`);
    }
    if (!releaseMode && !["Verified", "Pending"].includes(row.status)) {
      fail(`${id} has an unsupported status`);
    }
    await Promise.all([
      verifyEvidencePath(row.implementation, id, "implementation"),
      verifyEvidencePath(row.verification, id, "verification"),
    ]);
  }

  const ordered = ids.map((id) => byId.get(id));
  const verified = ordered.filter(({ status }) => status === "Verified").length;
  const artifact = Object.freeze({
    schema_version: "1",
    spec_sha256: createHash("sha256").update(spec, "utf8").digest("hex"),
    total: ordered.length,
    verified,
    release_mode: releaseMode,
    requirements: ordered,
  });
  await mkdir(resolve(ARTIFACT_PATH, ".."), { recursive: true });
  await writeFile(
    ARTIFACT_PATH,
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );
  return artifact;
}

try {
  const result = await verifyRequirements({
    releaseMode: parseArguments(process.argv.slice(2)),
  });
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      total: result.total,
      verified: result.verified,
      release_mode: result.release_mode,
      artifact: ARTIFACT_PATH,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `Requirement verification failed: ${
      error instanceof Error ? error.message : "unknown failure"
    }\n`,
  );
  process.exitCode = 1;
}
