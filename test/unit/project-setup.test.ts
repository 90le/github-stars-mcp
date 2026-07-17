import { expect, test } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../src/version.js";

test("exports package identity", () => {
  expect(PACKAGE_NAME).toBe("github-stars-mcp");
  expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
});
