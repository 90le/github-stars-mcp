import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

type PngMetadata = Readonly<{
  width: number;
  height: number;
  hasAlpha: boolean;
  uniqueColors: number;
}>;

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

async function readPngMetadata(path: string): Promise<PngMetadata> {
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 8), path).toEqual(PNG_SIGNATURE);

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const compressed: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8], path).toBe(8);
      colorType = data[9] ?? -1;
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }

  expect(colorType, path).toBe(6);
  const filtered = inflateSync(Buffer.concat(compressed));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[sourceOffset] ?? -1;
    sourceOffset += 1;
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[sourceOffset] ?? 0;
      sourceOffset += 1;
      const left = x >= 4 ? (pixels[y * stride + x - 4] ?? 0) : 0;
      const above = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const upperLeft =
        y > 0 && x >= 4 ? (pixels[(y - 1) * stride + x - 4] ?? 0) : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : filter === 4
                  ? paeth(left, above, upperLeft)
                  : -1;
      if (predictor < 0) {
        throw new Error(`${path}: unsupported PNG filter`);
      }
      pixels[y * stride + x] = (raw + predictor) & 0xff;
    }
  }

  const colors = new Set<string>();
  for (let index = 0; index < pixels.length; index += 4) {
    colors.add(
      `${pixels[index]},${pixels[index + 1]},${pixels[index + 2]},${pixels[index + 3]}`,
    );
    if (colors.size > 8) break;
  }
  return {
    width,
    height,
    hasAlpha: colorType === 4 || colorType === 6,
    uniqueColors: colors.size,
  };
}

describe("brand assets", () => {
  it.each([
    ["assets/social-preview.png", 1280, 640],
    ["plugins/github-stars-mcp/assets/icon.png", 256, 256],
    ["plugins/github-stars-mcp/assets/logo.png", 512, 512],
  ] as const)("validates %s", async (path, width, height) => {
    const image = await readPngMetadata(path);
    expect(image).toMatchObject({ width, height, hasAlpha: true });
    expect(image.uniqueColors).toBeGreaterThan(8);
  });
});
