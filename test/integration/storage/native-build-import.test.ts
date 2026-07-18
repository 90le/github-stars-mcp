import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";

test(
  "loads the built state-directory module in native Node",
  { timeout: 120_000 },
  () => {
    const output = mkdtempSync(join(tmpdir(), "github-stars-native-build-"));
    try {
      execFileSync(
        process.execPath,
        [
          join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
          "-p",
          "tsconfig.build.json",
          "--outDir",
          output,
        ],
        {
          cwd: process.cwd(),
          stdio: "pipe",
          timeout: 90_000,
          windowsHide: true,
        },
      );
      const entry = pathToFileURL(
        join(output, "storage", "state-directory.js"),
      ).href;
      expect(() =>
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `await import(${JSON.stringify(entry)})`,
          ],
          {
            cwd: process.cwd(),
            stdio: "pipe",
            timeout: 15_000,
            windowsHide: true,
          },
        ),
      ).not.toThrow();
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  },
);
