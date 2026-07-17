import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");

const readRepositoryFile = (path: string): Promise<string> =>
  readFile(resolve(repositoryRoot, path), "utf8");

describe("open-source governance", () => {
  it("ships the unmodified Apache License 2.0 text", async () => {
    const license = (await readRepositoryFile("LICENSE")).replaceAll(
      "\r\n",
      "\n",
    );

    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");
    expect(createHash("sha256").update(license).digest("hex")).toBe(
      "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    );
  });

  it("publishes Contributor Covenant 2.1 with a private reporting route", async () => {
    const conduct = await readRepositoryFile("CODE_OF_CONDUCT.md");

    expect(conduct).toContain("# Contributor Covenant Code of Conduct");
    expect(conduct).toContain("version/2/1/code_of_conduct.html");
    expect(conduct).toContain(
      "https://github.com/90le/github-stars-mcp/security/advisories/new",
    );
    expect(conduct).not.toContain("[INSERT");
  });

  it("defines a test-first contribution and allowlist review contract", async () => {
    const contributing = await readRepositoryFile("CONTRIBUTING.md");

    expect(contributing).toContain("focused branch from `main`");
    expect(contributing).toContain("failing test before production behavior");
    expect(contributing).toContain("npm run verify");
    expect(contributing).toMatch(/package smoke test.*platform/i);
    expect(contributing).toContain("GitHub mutation allowlist");
    expect(contributing).toMatch(/expansion requires a security review/i);
    expect(contributing).toMatch(
      /Never place real tokens, private repository metadata, or live-account mutation fixtures in commits/,
    );
  });

  it("documents supported versions and private vulnerability reporting", async () => {
    const security = await readRepositoryFile("SECURITY.md");

    expect(security).toContain("Private vulnerability reporting");
    expect(security).toContain(
      "https://github.com/90le/github-stars-mcp/security/advisories/new",
    );
    expect(security).toMatch(/\|\s*1\.x\s*\|\s*Yes\s*\|/);
    expect(security).toMatch(/affected version/i);
    expect(security).toMatch(/reproduction steps/i);
    expect(security).toMatch(/security impact/i);
    expect(security).toMatch(/do not include.*token/i);
    expect(security).not.toMatch(/open a public issue for a vulnerability/i);
    expect(security).not.toMatch(
      /(?:respond|reply|fix|resolve).{0,30}(?:within|in)\s+\d+\s+(?:hour|day)/i,
    );
  });

  it("requires safety and test evidence in pull requests", async () => {
    const template = await readRepositoryFile(
      ".github/pull_request_template.md",
    );

    expect(template).toContain("GitHub mutation allowlist");
    expect(template).toContain("npm run verify");
    expect(template).toMatch(/allowlist.*unchanged|changed.*security review/is);
    expect(template).toMatch(/token|credential/i);
    expect(template).toMatch(/- \[ \]/);
  });

  it("provides structured bug and feature issue forms", async () => {
    const paths = [
      ".github/ISSUE_TEMPLATE/bug.yml",
      ".github/ISSUE_TEMPLATE/feature.yml",
    ];

    for (const path of paths) {
      const source = await readRepositoryFile(path);
      expect(source, path).toMatch(/^name:\s*.+$/m);
      expect(source, path).toMatch(/^description:\s*.+$/m);
      expect(source, path).toMatch(/^body:\s*$/m);
    }

    const bug = await readRepositoryFile(paths[0]!);
    expect(bug).toMatch(/version/i);
    expect(bug).toMatch(/reproduction/i);
    expect(bug).toMatch(/operating system/i);
    expect(bug).toMatch(/redact/i);

    const feature = await readRepositoryFile(paths[1]!);
    expect(feature).toMatch(/use case/i);
    expect(feature).toContain("GitHub mutation allowlist");
    expect(feature).toMatch(/safety/i);
  });

  it("checks repository YAML and reports duplicate keys without source values", async () => {
    const verifier = resolve(repositoryRoot, "scripts/verify-yaml.mjs");
    const valid = await execFileAsync(process.execPath, [verifier], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    expect(valid.stderr).toBe("");
    expect(valid.stdout).toMatch(/Validated \d+ YAML files\./);

    const fixtureRoot = await mkdtemp(join(tmpdir(), "github-stars-yaml-"));
    const secret = "ghp_FICTIONAL_SECRET_VALUE_MUST_NOT_PRINT";
    try {
      await execFileAsync("git", ["init", "--quiet"], { cwd: fixtureRoot });
      await writeFile(
        join(fixtureRoot, "duplicate.yml"),
        `token: ${secret}\ntoken: second-value\n`,
        "utf8",
      );

      const failure: unknown = await execFileAsync(
        process.execPath,
        [verifier],
        {
          cwd: fixtureRoot,
          encoding: "utf8",
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      if (
        typeof failure !== "object" ||
        failure === null ||
        !("stderr" in failure) ||
        typeof failure.stderr !== "string"
      ) {
        throw new Error("Expected the YAML verifier to return stderr.");
      }

      expect("code" in failure ? failure.code : undefined).toBe(1);
      expect(failure.stderr).toMatch(
        /duplicate\.yml:\d+:\d+ \(DUPLICATE_KEY\)/,
      );
      expect(failure.stderr).not.toContain(secret);
      expect(failure.stderr).not.toContain("second-value");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
