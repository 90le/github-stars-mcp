import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const PORT_SOURCE = new URL(
  "../../src/app/ports/github-port.ts",
  import.meta.url,
);
const ALLOWLIST_SOURCE = new URL(
  "../../src/github/allowed-operations.ts",
  import.meta.url,
);

function interfaceMethodNames(source: string, interfaceName: string): string[] {
  const interfaceBody = new RegExp(
    `export interface ${interfaceName}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`,
    "u",
  ).exec(source)?.groups?.body;

  if (interfaceBody === undefined) {
    throw new Error(`Could not locate ${interfaceName}`);
  }

  return [...interfaceBody.matchAll(/^\s{2}([A-Za-z]\w*)\s*\(/gmu)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined)
    .sort();
}

describe("GitHub read capability boundary", () => {
  it("exposes only approved named application operations", async () => {
    const source = await readFile(PORT_SOURCE, "utf8");

    expect(interfaceMethodNames(source, "GitHubPort")).toEqual(
      [
        "getReadme",
        "getViewer",
        "listStarredRepositories",
        "listUserListItems",
        "listUserLists",
        "probeCapabilities",
        "searchRepositories",
      ].sort(),
    );
    expect(source).not.toMatch(
      /\b(?:request|graphql|rawRequest|deleteRepository|archiveRepository|transferRepository|updateRepository|updateFile|createOrUpdateFile|deleteFile|createCommit)\s*\(/u,
    );
  });

  it("contains no mutation document or non-GET REST route in the read allowlist", async () => {
    const source = await readFile(ALLOWLIST_SOURCE, "utf8");

    expect(source).not.toMatch(/\bmutation\b/u);
    expect(source).not.toMatch(/["'`](?:POST|PUT|PATCH|DELETE)\s+\//u);
    expect(source).not.toMatch(/https?:\/\//u);
    expect(source).not.toMatch(
      /\b(?:deleteRepository|archiveRepository|transferRepository|updateRepository|updateFile|createOrUpdateFile|deleteFile|createCommit)\b/u,
    );
  });
});
