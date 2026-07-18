import { readFileSync } from "node:fs";

function packageIdentity(): Readonly<{ name: string; version: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
  } catch {
    throw new Error("Package metadata is unavailable");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("name" in parsed) ||
    parsed.name !== "github-stars-mcp" ||
    !("version" in parsed) ||
    typeof parsed.version !== "string" ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(parsed.version)
  ) {
    throw new Error("Package metadata is invalid");
  }
  return Object.freeze({ name: parsed.name, version: parsed.version });
}

const IDENTITY = packageIdentity();

export const PACKAGE_NAME = IDENTITY.name;
export const PACKAGE_VERSION = IDENTITY.version;
