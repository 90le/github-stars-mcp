/* global process */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectRgbaPng } from "./png-assets.mjs";

const ASSETS = Object.freeze([
  Object.freeze({
    path: "assets/social-preview.png",
    width: 1280,
    height: 640,
  }),
  Object.freeze({
    path: "plugins/github-stars-mcp/assets/icon.png",
    width: 256,
    height: 256,
  }),
  Object.freeze({
    path: "plugins/github-stars-mcp/assets/logo.png",
    width: 512,
    height: 512,
  }),
]);
const MAX_EMPTY_BORDER_RATIO = 0.12;

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function findOpaqueBounds(path, width, height, pixels) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = pixels[(y * width + x) * 4 + 3] ?? 0;
      if (alpha === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY)
    return fail(path, "image is fully transparent");
  return { minX, minY, maxX, maxY };
}

export async function inspectPng(path) {
  const bytes = await readFile(path);
  let inspected;
  try {
    const asset = ASSETS.find((candidate) => candidate.path === path);
    if (asset === undefined) return fail(path, "asset is not allowlisted");
    inspected = inspectRgbaPng(bytes, asset);
  } catch {
    return fail(path, "invalid or non-canonical RGBA PNG");
  }
  const bounds = findOpaqueBounds(
    path,
    inspected.width,
    inspected.height,
    inspected.pixels,
  );
  const emptyRatios = [
    bounds.minX / inspected.width,
    (inspected.width - 1 - bounds.maxX) / inspected.width,
    bounds.minY / inspected.height,
    (inspected.height - 1 - bounds.maxY) / inspected.height,
  ];
  if (emptyRatios.some((ratio) => ratio > MAX_EMPTY_BORDER_RATIO)) {
    return fail(path, "transparent empty border exceeds 12 percent");
  }
  return Object.freeze({
    width: inspected.width,
    height: inspected.height,
    bytes: inspected.bytes,
  });
}

export async function verifyAssets() {
  for (const asset of ASSETS) {
    const metadata = await inspectPng(asset.path);
    if (metadata.width !== asset.width || metadata.height !== asset.height) {
      fail(
        asset.path,
        `expected ${asset.width}x${asset.height}, received ${metadata.width}x${metadata.height}`,
      );
    }
  }
  process.stdout.write(`Validated ${ASSETS.length} brand assets.\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await verifyAssets();
}
