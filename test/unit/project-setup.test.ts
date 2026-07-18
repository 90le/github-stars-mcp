import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../src/version.js";
import vitestConfig from "../../vitest.config.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

test("exports package identity", () => {
  expect(PACKAGE_NAME).toBe("github-stars-mcp");
  expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
});

test("includes every source file in coverage", () => {
  expect(vitestConfig.test?.coverage).toMatchObject({
    include: ["src/**/*.ts"],
  });
});

test("normalizes tracked text files to LF in every checkout", () => {
  const attributes = readFileSync(
    new URL("../../.gitattributes", import.meta.url),
    "utf8",
  );

  expect(attributes).toMatch(/^\* text=auto eol=lf$/mu);
});

test("uses only the official npm registry in the shrinkwrap", () => {
  const shrinkwrap: unknown = JSON.parse(
    readFileSync(new URL("../../npm-shrinkwrap.json", import.meta.url), "utf8"),
  );

  if (!isRecord(shrinkwrap) || !isRecord(shrinkwrap.packages)) {
    throw new TypeError("Invalid npm shrinkwrap");
  }

  const resolvedUrls = Object.values(shrinkwrap.packages).flatMap((entry) =>
    isRecord(entry) && typeof entry.resolved === "string"
      ? [entry.resolved]
      : [],
  );

  expect(resolvedUrls).not.toHaveLength(0);
  expect(
    resolvedUrls.find((url) => !url.startsWith("https://registry.npmjs.org/")),
  ).toBeUndefined();
});
