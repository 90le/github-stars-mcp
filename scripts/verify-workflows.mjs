/* global console, process */

import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
} from "yaml";

const EXPECTED_WORKFLOWS = [
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/package-smoke.yml",
];

const PINS = Object.freeze({
  checkout: "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
  codeqlAnalyze:
    "github/codeql-action/analyze@ddf5ce7296213f5548c91e2dd19df2d77d2b2d66",
  codeqlInit:
    "github/codeql-action/init@ddf5ce7296213f5548c91e2dd19df2d77d2b2d66",
  dependencyReview:
    "actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294",
  setupNode: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
});

const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;
const LIVE_TOKEN_NAME = /^(?:GITHUB_STARS_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/;
const LIVE_TOKEN_VALUE =
  /(?:\$\{\{\s*(?:secrets\.|github\.token)|\bGITHUB_STARS_TOKEN\b|\bGITHUB_TOKEN\b|\bGH_TOKEN\b|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]{16,})/i;
const STANDARD_YAML_TAGS = new Set([
  "tag:yaml.org,2002:binary",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:omap",
  "tag:yaml.org,2002:pairs",
  "tag:yaml.org,2002:seq",
  "tag:yaml.org,2002:set",
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:timestamp",
]);

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function displayPath(path) {
  return JSON.stringify(path).slice(1, -1);
}

function scalarKey(pair) {
  return isScalar(pair?.key) && typeof pair.key.value === "string"
    ? pair.key.value
    : undefined;
}

function pairAt(map, key) {
  if (!isMap(map)) return undefined;
  return map.items.find((pair) => scalarKey(pair) === key);
}

function nodeAt(root, path) {
  let node = root;
  for (const segment of path) {
    const pair = pairAt(node, segment);
    if (pair === undefined) return undefined;
    node = pair.value;
  }
  return node;
}

function scalarText(node) {
  if (!isScalar(node)) return undefined;
  if (
    typeof node.value !== "string" &&
    typeof node.value !== "number" &&
    typeof node.value !== "boolean"
  ) {
    return undefined;
  }
  return String(node.value);
}

function sequenceText(node) {
  if (!isSeq(node)) return undefined;
  const values = [];
  for (const item of node.items) {
    const value = scalarText(item);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

function sameTextSet(actual, expected) {
  if (actual === undefined || actual.length !== expected.length) return false;
  return (
    [...actual].sort(compareText).join("\0") ===
    [...expected].sort(compareText).join("\0")
  );
}

function walk(node, visitor) {
  if (isMap(node)) {
    for (const pair of node.items) {
      visitor(pair);
      walk(pair.key, visitor);
      walk(pair.value, visitor);
    }
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) walk(item, visitor);
  }
}

function issueAt(context, node, code) {
  const offset =
    node !== null &&
    typeof node === "object" &&
    Array.isArray(node.range) &&
    typeof node.range[0] === "number"
      ? node.range[0]
      : 0;
  const position = context.lineCounter.linePos(offset);
  context.issues.push({
    path: context.path,
    line: position.line,
    column: position.col,
    code,
  });
}

function validateYamlStructure(context) {
  function visit(node) {
    if (isAlias(node)) {
      issueAt(context, node, "YAML_ALIAS_FORBIDDEN");
      return;
    }
    if (node === null || typeof node !== "object") return;

    if (typeof node.anchor === "string") {
      issueAt(context, node, "YAML_ANCHOR_FORBIDDEN");
    }
    if (typeof node.tag === "string" && !STANDARD_YAML_TAGS.has(node.tag)) {
      issueAt(context, node, "YAML_CUSTOM_TAG_FORBIDDEN");
    }

    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          issueAt(context, pair.key, "YAML_DYNAMIC_KEY_FORBIDDEN");
        } else if (pair.key.value === "<<") {
          issueAt(context, pair.key, "YAML_MERGE_KEY_FORBIDDEN");
        }
        visit(pair.key);
        visit(pair.value);
      }
      return;
    }
    if (isSeq(node)) {
      for (const item of node.items) visit(item);
    }
  }

  visit(context.root);
}

function parseYaml(path, source, issues) {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    lineCounter,
    prettyErrors: false,
    uniqueKeys: true,
  });
  const context = {
    path,
    document,
    lineCounter,
    root: document.contents,
    issues,
  };

  for (const error of document.errors) {
    const position = Array.isArray(error.linePos)
      ? error.linePos[0]
      : undefined;
    issues.push({
      path,
      line: position?.line ?? 1,
      column: position?.col ?? 1,
      code:
        typeof error.code === "string" && /^[A-Z_]+$/.test(error.code)
          ? error.code
          : "YAML_PARSE_ERROR",
    });
  }

  if (document.errors.length === 0 && !isMap(document.contents)) {
    issueAt(context, document.contents, "ROOT_MAPPING_REQUIRED");
  }
  return context;
}

function expectScalar(context, path, expected, code) {
  const node = nodeAt(context.root, path);
  if (scalarText(node) !== expected) issueAt(context, node, code);
}

function expectSequence(context, path, expected, code) {
  const node = nodeAt(context.root, path);
  if (!sameTextSet(sequenceText(node), expected)) issueAt(context, node, code);
}

function expectMapping(context, path, expected, code) {
  const node = nodeAt(context.root, path);
  if (!isMap(node) || node.items.length !== Object.keys(expected).length) {
    issueAt(context, node, code);
    return;
  }
  for (const [key, value] of Object.entries(expected)) {
    if (scalarText(pairAt(node, key)?.value) !== value) {
      issueAt(context, pairAt(node, key)?.value ?? node, code);
    }
  }
}

function hasMapKey(node, key) {
  return pairAt(node, key) !== undefined;
}

function requirePullRequestAndMainPush(context, code) {
  const triggers = nodeAt(context.root, ["on"]);
  const push = pairAt(triggers, "push")?.value;
  if (
    !isMap(triggers) ||
    !hasMapKey(triggers, "pull_request") ||
    !isMap(push) ||
    !sameTextSet(sequenceText(pairAt(push, "branches")?.value), ["main"])
  ) {
    issueAt(context, triggers, code);
  }
}

function stepMaps(context, jobName) {
  const steps = nodeAt(context.root, ["jobs", jobName, "steps"]);
  if (!isSeq(steps)) return [];
  return steps.items.filter((item) => isMap(item));
}

function stepValues(steps, key) {
  const values = [];
  for (const step of steps) {
    const value = scalarText(pairAt(step, key)?.value);
    if (value !== undefined) values.push(value);
  }
  return values;
}

function expectStepValues(context, steps, key, expected, code) {
  const values = stepValues(steps, key);
  for (const value of expected) {
    if (!values.includes(value)) issueAt(context, context.root, code);
  }
}

function validateCheckoutPersistence(context, steps) {
  for (const step of steps) {
    if (scalarText(pairAt(step, "uses")?.value) !== PINS.checkout) continue;
    const persisted = nodeAt(step, ["with", "persist-credentials"]);
    if (scalarText(persisted) !== "false") {
      issueAt(context, persisted ?? step, "CHECKOUT_CREDENTIAL_PERSISTENCE");
    }
  }
}

function allowedWrites(path) {
  const name = basename(path);
  if (name === "codeql.yml" || name === "codeql.yaml") {
    return new Set(["security-events"]);
  }
  if (name === "release.yml" || name === "release.yaml") {
    return new Set(["attestations", "contents", "id-token"]);
  }
  return new Set();
}

function validatePermissionMap(context, node, writes) {
  if (!isMap(node)) {
    issueAt(context, node, "PERMISSIONS_MAP_REQUIRED");
    return;
  }
  for (const pair of node.items) {
    const key = scalarKey(pair);
    const value = scalarText(pair.value);
    if (key === undefined || !["none", "read", "write"].includes(value ?? "")) {
      issueAt(context, pair.value ?? pair.key, "PERMISSION_VALUE_INVALID");
      continue;
    }
    if (value === "write" && !writes.has(key)) {
      issueAt(context, pair.value, "PERMISSION_WRITE_FORBIDDEN");
    }
  }
}

function validateGenericWorkflow(context) {
  const writes = allowedWrites(context.path);
  const rootPermissions = nodeAt(context.root, ["permissions"]);
  if (rootPermissions === undefined) {
    issueAt(context, context.root, "WORKFLOW_PERMISSIONS_REQUIRED");
  }

  walk(context.root, (pair) => {
    const key = scalarKey(pair);
    if (key === "uses") {
      const reference = scalarText(pair.value);
      if (
        reference === undefined ||
        (!reference.startsWith("./") && !PINNED_ACTION.test(reference))
      ) {
        issueAt(context, pair.value, "UNPINNED_ACTION");
      }
    }

    if (key === "permissions") {
      validatePermissionMap(context, pair.value, writes);
    }

    if (key !== undefined && LIVE_TOKEN_NAME.test(key)) {
      issueAt(context, pair.key, "LIVE_TOKEN_REFERENCE");
    }

    if (key === "GITHUB_STARS_MCP_READ_ONLY") {
      const value = scalarText(pair.value);
      if (value !== "true") issueAt(context, pair.value, "READ_ONLY_REQUIRED");
    }

    const value = scalarText(pair.value);
    if (typeof value === "string" && LIVE_TOKEN_VALUE.test(value)) {
      issueAt(context, pair.value, "LIVE_TOKEN_REFERENCE");
    }
  });
}

function validateCi(context) {
  expectMapping(
    context,
    ["permissions"],
    { contents: "read" },
    "CI_PERMISSIONS",
  );
  requirePullRequestAndMainPush(context, "CI_TRIGGERS");
  expectScalar(
    context,
    ["env", "GITHUB_STARS_MCP_READ_ONLY"],
    "true",
    "READ_ONLY_REQUIRED",
  );
  expectScalar(
    context,
    ["jobs", "verify", "runs-on"],
    "ubuntu-latest",
    "CI_RUNNER",
  );
  expectSequence(
    context,
    ["jobs", "verify", "strategy", "matrix", "node-version"],
    ["22", "24"],
    "CI_NODE_MATRIX",
  );

  const verifySteps = stepMaps(context, "verify");
  expectStepValues(
    context,
    verifySteps,
    "uses",
    [PINS.checkout, PINS.setupNode],
    "CI_ACTIONS",
  );
  expectStepValues(
    context,
    verifySteps,
    "run",
    ["npm ci", "npm run verify"],
    "CI_COMMANDS",
  );
  validateCheckoutPersistence(context, verifySteps);

  const reviewSteps = stepMaps(context, "dependency-review");
  expectScalar(
    context,
    ["jobs", "dependency-review", "if"],
    "github.event_name == 'pull_request'",
    "DEPENDENCY_REVIEW_TRIGGER",
  );
  expectStepValues(
    context,
    reviewSteps,
    "uses",
    [PINS.checkout, PINS.dependencyReview],
    "DEPENDENCY_REVIEW_ACTIONS",
  );
  validateCheckoutPersistence(context, reviewSteps);
}

function validatePackageSmoke(context) {
  expectMapping(
    context,
    ["permissions"],
    { contents: "read" },
    "PACKAGE_PERMISSIONS",
  );
  requirePullRequestAndMainPush(context, "PACKAGE_TRIGGERS");
  expectScalar(
    context,
    ["env", "GITHUB_STARS_MCP_READ_ONLY"],
    "true",
    "READ_ONLY_REQUIRED",
  );
  expectScalar(
    context,
    ["jobs", "package-smoke", "runs-on"],
    "${{ matrix.os }}",
    "PACKAGE_RUNNER_MATRIX",
  );
  expectSequence(
    context,
    ["jobs", "package-smoke", "strategy", "matrix", "os"],
    ["ubuntu-latest", "macos-latest", "windows-latest"],
    "PACKAGE_OS_MATRIX",
  );
  expectSequence(
    context,
    ["jobs", "package-smoke", "strategy", "matrix", "node-version"],
    ["22", "24"],
    "PACKAGE_NODE_MATRIX",
  );

  const steps = stepMaps(context, "package-smoke");
  expectStepValues(
    context,
    steps,
    "uses",
    [PINS.checkout, PINS.setupNode],
    "PACKAGE_ACTIONS",
  );
  expectStepValues(
    context,
    steps,
    "run",
    ["npm ci", "npm run build", "npm run package:verify"],
    "PACKAGE_COMMANDS",
  );
  const probeStep = steps.find(
    (step) =>
      scalarText(pairAt(step, "run")?.value) === "npm run package:verify",
  );
  const probeName = scalarText(pairAt(probeStep, "name")?.value) ?? "";
  if (
    !probeName.includes("--help") ||
    !probeName.includes("--version") ||
    !probeName.includes("--doctor") ||
    !probeName.toLowerCase().includes("fixture-backed")
  ) {
    issueAt(context, probeStep ?? context.root, "PACKAGE_PROBE_CONTRACT");
  }
  validateCheckoutPersistence(context, steps);
}

function validateCodeql(context) {
  expectMapping(
    context,
    ["permissions"],
    { contents: "read", "security-events": "write" },
    "CODEQL_PERMISSIONS",
  );
  requirePullRequestAndMainPush(context, "CODEQL_TRIGGERS");
  const triggers = nodeAt(context.root, ["on"]);
  if (!isSeq(pairAt(triggers, "schedule")?.value)) {
    issueAt(context, triggers, "CODEQL_SCHEDULE");
  }
  expectScalar(
    context,
    ["env", "GITHUB_STARS_MCP_READ_ONLY"],
    "true",
    "READ_ONLY_REQUIRED",
  );

  const steps = stepMaps(context, "analyze");
  expectStepValues(
    context,
    steps,
    "uses",
    [PINS.checkout, PINS.codeqlInit, PINS.setupNode, PINS.codeqlAnalyze],
    "CODEQL_ACTIONS",
  );
  expectStepValues(
    context,
    steps,
    "run",
    ["npm ci", "npm run build"],
    "CODEQL_COMMANDS",
  );
  const init = steps.find(
    (step) => scalarText(pairAt(step, "uses")?.value) === PINS.codeqlInit,
  );
  if (
    scalarText(nodeAt(init, ["with", "languages"])) !== "javascript-typescript"
  ) {
    issueAt(context, init ?? context.root, "CODEQL_LANGUAGE");
  }
  validateCheckoutPersistence(context, steps);
}

function validateDependabot(context) {
  expectScalar(context, ["version"], "2", "DEPENDABOT_VERSION");
  const updates = nodeAt(context.root, ["updates"]);
  if (!isSeq(updates) || updates.items.length !== 2) {
    issueAt(context, updates, "DEPENDABOT_ECOSYSTEMS");
    return;
  }

  const seen = new Set();
  for (const update of updates.items) {
    if (!isMap(update)) {
      issueAt(context, update, "DEPENDABOT_UPDATE_MAPPING");
      continue;
    }
    const ecosystem = scalarText(pairAt(update, "package-ecosystem")?.value);
    if (ecosystem !== "npm" && ecosystem !== "github-actions") {
      issueAt(
        context,
        pairAt(update, "package-ecosystem")?.value ?? update,
        "DEPENDABOT_ECOSYSTEMS",
      );
      continue;
    }
    if (seen.has(ecosystem)) {
      issueAt(context, update, "DEPENDABOT_ECOSYSTEMS");
    }
    seen.add(ecosystem);

    if (scalarText(pairAt(update, "directory")?.value) !== "/") {
      issueAt(context, update, "DEPENDABOT_DIRECTORY");
    }
    if (scalarText(nodeAt(update, ["schedule", "interval"])) !== "weekly") {
      issueAt(context, update, "DEPENDABOT_SCHEDULE");
    }
    if (
      scalarText(pairAt(update, "open-pull-requests-limit")?.value) !== "10"
    ) {
      issueAt(
        context,
        pairAt(update, "open-pull-requests-limit")?.value ?? update,
        "DEPENDABOT_PULL_REQUEST_LIMIT",
      );
    }
  }

  if (!seen.has("npm") || !seen.has("github-actions")) {
    issueAt(context, updates, "DEPENDABOT_ECOSYSTEMS");
  }
}

async function workflowPaths(root, issues) {
  const directory = resolve(root, ".github/workflows");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    for (const path of EXPECTED_WORKFLOWS) {
      issues.push({
        path,
        line: 1,
        column: 1,
        code: "WORKFLOW_MISSING",
      });
    }
    return [];
  }

  const paths = entries
    .filter((entry) => entry.isFile() && /\.(?:yml|yaml)$/i.test(entry.name))
    .map((entry) => `.github/workflows/${entry.name}`)
    .sort(compareText);
  for (const expected of EXPECTED_WORKFLOWS) {
    if (!paths.includes(expected)) {
      issues.push({
        path: expected,
        line: 1,
        column: 1,
        code: "WORKFLOW_MISSING",
      });
    }
  }
  return paths;
}

async function readPolicyFile(root, path, issues) {
  try {
    return await readFile(resolve(root, path), "utf8");
  } catch {
    issues.push({ path, line: 1, column: 1, code: "POLICY_FILE_MISSING" });
    return undefined;
  }
}

export async function verifyRepository(root = process.cwd()) {
  const issues = [];
  const paths = await workflowPaths(root, issues);

  for (const path of paths) {
    const source = await readPolicyFile(root, path, issues);
    if (source === undefined) continue;
    const context = parseYaml(path, source, issues);
    if (context.document.errors.length > 0) continue;
    validateYamlStructure(context);
    if (!isMap(context.root)) continue;

    validateGenericWorkflow(context);
    if (path === ".github/workflows/ci.yml") validateCi(context);
    if (path === ".github/workflows/package-smoke.yml") {
      validatePackageSmoke(context);
    }
    if (path === ".github/workflows/codeql.yml") validateCodeql(context);
  }

  const dependabotPath = ".github/dependabot.yml";
  const dependabotSource = await readPolicyFile(root, dependabotPath, issues);
  if (dependabotSource !== undefined) {
    const context = parseYaml(dependabotPath, dependabotSource, issues);
    if (context.document.errors.length === 0) {
      validateYamlStructure(context);
    }
    if (context.document.errors.length === 0 && isMap(context.root)) {
      validateDependabot(context);
    }
  }

  issues.sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      left.line - right.line ||
      left.column - right.column ||
      compareText(left.code, right.code),
  );
  return { issues, workflowCount: paths.length, dependencyEcosystemCount: 2 };
}

function parseRootArgument(args) {
  if (args.length === 0) return process.cwd();
  if (args.length === 2 && args[0] === "--root") return resolve(args[1]);
  return undefined;
}

export async function main(args = process.argv.slice(2)) {
  const root = parseRootArgument(args);
  if (root === undefined) {
    console.error(
      "Workflow policy failed: <arguments>:1:1 (CLI_ARGUMENT_ERROR)",
    );
    return 1;
  }

  let result;
  try {
    result = await verifyRepository(root);
  } catch {
    console.error("Workflow policy failed: <repository>:1:1 (INTERNAL_ERROR)");
    return 1;
  }

  if (result.issues.length > 0) {
    for (const issue of result.issues) {
      console.error(
        `Workflow policy failed: ${displayPath(issue.path)}:${issue.line}:${issue.column} (${issue.code})`,
      );
    }
    return 1;
  }

  console.log(
    `Workflow policy check passed: ${result.workflowCount} workflows and ${result.dependencyEcosystemCount} dependency ecosystems.`,
  );
  return 0;
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  pathToFileURL(resolve(entryPath)).href === import.meta.url
) {
  process.exitCode = await main();
}
