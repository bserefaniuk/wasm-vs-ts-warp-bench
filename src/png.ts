/**
 * png.ts — minimal PNG encoder for RGBA8 images (benchmark support only).
 *
 * Produces a valid PNG: IHDR (color type 6 = truecolor + alpha, bit depth 8),
 * one IDAT (zlib deflate of scanlines, filter byte 0 per scanline), IEND.
 * Needed because the WASM engine's create_session() takes encoded bytes.
 */

import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ── CRC32 (table-driven, polynomial 0xEDB88320) ────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ── Chunk writer ───────────────────────────────────────────────────

/** Build a PNG chunk: length (u32be) + type (4 ASCII) + data + CRC32(type+data). */
function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length), false);
  return out;
}

// ── Encoder ────────────────────────────────────────────────────────

/**
 * Encode raw RGBA8 pixels as a PNG file.
 *
 * @param rgba   - pixel data, length must equal width * height * 4
 * @param width  - image width in pixels (> 0)
 * @param height - image height in pixels (> 0)
 */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (width <= 0 || height <= 0) {
    throw new Error(`encodePng: invalid dimensions ${width}x${height}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(
      `encodePng: buffer length ${rgba.length} != ${width}x${height}x4 (${width * height * 4})`,
    );
  }

  // IHDR: width, height, bit depth 8, color type 6 (RGBA), deflate, filter 0, no interlace
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor with alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // no interlace

  // Scanlines: each row prefixed with filter byte 0 (None)
  const rowBytes = width * 4;
  const raw = new Uint8Array(height * (1 + rowBytes));
  for (let y = 0; y < height; y++) {
    const rawPos = y * (1 + rowBytes);
    raw[rawPos] = 0; // filter: None
    raw.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), rawPos + 1);
  }
  const idat = new Uint8Array(deflateSync(raw, { level: 6 }));

  const chunks = [
    PNG_SIGNATURE,
    buildChunk('IHDR', ihdr),
    buildChunk('IDAT', idat),
    buildChunk('IEND', new Uint8Array(0)),
  ];
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
