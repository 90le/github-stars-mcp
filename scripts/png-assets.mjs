import { Buffer } from "node:buffer";
import { inflateSync } from "node:zlib";

export const MAX_PNG_BYTES = 1_500_000;

export const PLUGIN_BRAND_ASSETS = Object.freeze({
  composerIcon: Object.freeze({
    reference: "./assets/icon.png",
    relativePath: "assets/icon.png",
    width: 256,
    height: 256,
  }),
  logo: Object.freeze({
    reference: "./assets/logo.png",
    relativePath: "assets/logo.png",
    width: 512,
    height: 512,
  }),
});

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function invalidPng() {
  throw new Error("INVALID_PNG");
}

function pngCrc32(contents, start, end) {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc ^= contents[offset];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodeRgba(width, height, compressed) {
  const compressedBytes = Buffer.concat(compressed);
  const stride = width * 4;
  const filteredLength = (stride + 1) * height;
  let result;
  try {
    result = inflateSync(compressedBytes, {
      info: true,
      maxOutputLength: filteredLength,
    });
  } catch {
    return invalidPng();
  }
  if (
    result.buffer.length !== filteredLength ||
    result.engine.bytesWritten !== compressedBytes.length
  ) {
    return invalidPng();
  }

  const pixels = Buffer.alloc(stride * height);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = result.buffer[sourceOffset];
    sourceOffset += 1;
    if (filter === undefined || filter > 4) return invalidPng();
    for (let x = 0; x < stride; x += 1) {
      const raw = result.buffer[sourceOffset];
      if (raw === undefined) return invalidPng();
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
                : paeth(left, above, upperLeft);
      pixels[y * stride + x] = (raw + predictor) & 0xff;
    }
  }
  return pixels;
}

export function inspectRgbaPng(contents, expected) {
  if (
    !Buffer.isBuffer(contents) ||
    contents.length > MAX_PNG_BYTES ||
    !contents.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return invalidPng();
  }

  let offset = PNG_SIGNATURE.length;
  let header;
  const compressed = [];
  let sawEnd = false;
  let chunkIndex = 0;
  while (offset < contents.length) {
    if (contents.length - offset < 12) return invalidPng();
    const length = contents.readUInt32BE(offset);
    if (length > contents.length - offset - 12) return invalidPng();

    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    const typeBytes = contents.subarray(typeStart, dataStart);
    const type = typeBytes.toString("ascii");
    if (
      !typeBytes.every(
        (value) =>
          (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a),
      ) ||
      pngCrc32(contents, typeStart, dataEnd) !== contents.readUInt32BE(dataEnd)
    ) {
      return invalidPng();
    }

    if (type === "IHDR") {
      if (chunkIndex !== 0 || header !== undefined || length !== 13) {
        return invalidPng();
      }
      header = Object.freeze({
        width: contents.readUInt32BE(dataStart),
        height: contents.readUInt32BE(dataStart + 4),
        bitDepth: contents[dataStart + 8],
        colorType: contents[dataStart + 9],
        compression: contents[dataStart + 10],
        filter: contents[dataStart + 11],
        interlace: contents[dataStart + 12],
      });
    } else if (type === "IDAT") {
      if (header === undefined) return invalidPng();
      compressed.push(contents.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (
        header === undefined ||
        compressed.length === 0 ||
        sawEnd ||
        length !== 0 ||
        crcEnd !== contents.length
      ) {
        return invalidPng();
      }
      sawEnd = true;
    } else {
      return invalidPng();
    }

    offset = crcEnd;
    chunkIndex += 1;
  }

  if (
    header === undefined ||
    !sawEnd ||
    header.width !== expected.width ||
    header.height !== expected.height ||
    header.bitDepth !== 8 ||
    header.colorType !== 6 ||
    header.compression !== 0 ||
    header.filter !== 0 ||
    header.interlace !== 0
  ) {
    return invalidPng();
  }

  const pixels = decodeRgba(header.width, header.height, compressed);
  return Object.freeze({
    width: header.width,
    height: header.height,
    bytes: contents.length,
    pixels,
  });
}
