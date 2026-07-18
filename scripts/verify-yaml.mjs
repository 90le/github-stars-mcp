/* global console, process */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseAllDocuments } from "yaml";

const YAML_PATH = /\.ya?ml$/i;

function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function displayPath(path) {
  return JSON.stringify(path).slice(1, -1);
}

function parserIssue(path, error) {
  const position = Array.isArray(error?.linePos) ? error.linePos[0] : undefined;
  const line =
    typeof position?.line === "number" && position.line > 0 ? position.line : 1;
  const column =
    typeof position?.col === "number" && position.col > 0 ? position.col : 1;
  const code =
    typeof error?.code === "string" && /^[A-Z_]+$/.test(error.code)
      ? error.code
      : "YAML_PARSE_ERROR";
  return { path, line, column, code };
}

export function listRepositoryYamlFiles(root = process.cwd()) {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  return output
    .split("\0")
    .filter((path) => path.length > 0 && YAML_PATH.test(path))
    .sort(comparePaths);
}

export async function verifyYamlFiles(paths, root = process.cwd()) {
  const issues = [];

  for (const path of paths) {
    let source;
    try {
      source = await readFile(resolve(root, path), "utf8");
    } catch {
      issues.push({ path, line: 1, column: 1, code: "YAML_READ_ERROR" });
      continue;
    }

    const documents = parseAllDocuments(source, {
      prettyErrors: false,
      uniqueKeys: true,
    });
    for (const document of documents) {
      for (const error of document.errors) {
        issues.push(parserIssue(path, error));
      }
    }
  }

  return issues;
}

export async function main(root = process.cwd()) {
  let paths;
  try {
    paths = listRepositoryYamlFiles(root);
  } catch {
    console.error(
      "YAML validation failed: <repository>:1:1 (GIT_FILE_LIST_ERROR)",
    );
    return 1;
  }

  let issues;
  try {
    issues = await verifyYamlFiles(paths, root);
  } catch {
    console.error("YAML validation failed: <repository>:1:1 (INTERNAL_ERROR)");
    return 1;
  }

  if (issues.length > 0) {
    for (const issue of issues) {
      console.error(
        `YAML validation failed: ${displayPath(issue.path)}:${issue.line}:${issue.column} (${issue.code})`,
      );
    }
    return 1;
  }

  console.log(`Validated ${paths.length} YAML files.`);
  return 0;
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  pathToFileURL(resolve(entryPath)).href === import.meta.url
) {
  process.exitCode = await main();
}
