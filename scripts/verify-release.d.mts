export interface ReleaseMetadataOptions {
  root?: string;
  runtimeVersion?: string;
}

export interface ReleaseMetadata {
  name: "github-stars-mcp";
  version: string;
  npmSpecifier: string;
}

export function assertReleaseRevision(input: {
  version: string;
  headRevision: string;
  tagRevision: string;
}): void;

export function verifyReleaseMetadata(
  options?: ReleaseMetadataOptions,
): Promise<ReleaseMetadata>;

export function verifyNpmPackageName(
  name: string,
  fetchImplementation: (
    input: string,
    init: Record<string, unknown>,
  ) => Promise<{
    status: number;
    json(): Promise<unknown>;
  }>,
): Promise<Readonly<{ state: "unclaimed" | "owned" }>>;

export function verifyNpmPackageName(
  name: string,
  version: string,
  fetchImplementation?: (
    input: string,
    init: Record<string, unknown>,
  ) => Promise<{
    status: number;
    json(): Promise<unknown>;
  }>,
): Promise<Readonly<{ state: "unclaimed" | "owned" }>>;

export function prepareArtifactDirectory(root: string): Promise<string>;
export function prepareBuildOutput(root: string): Promise<void>;

export function releaseChildEnvironment(
  source?: Readonly<Record<string, string | undefined>>,
): Record<string, string>;

export function validateSbom(
  source: string,
  metadata: Readonly<{ name: string; version: string }>,
): void;

export function validatePackageMetadata(
  packageMetadata: Record<string, unknown>,
): void;
