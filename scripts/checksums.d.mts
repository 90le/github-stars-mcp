export interface ChecksumOptions {
  outputPath?: string;
}

export interface ChecksumResult {
  outputPath: string;
  files: readonly string[];
  lines: readonly string[];
}

export function writeChecksums(
  paths: readonly string[],
  options?: ChecksumOptions,
): Promise<ChecksumResult>;
