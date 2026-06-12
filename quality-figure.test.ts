/**
 * Regenerates the source renders for the article's quality before/after
 * figure: a fine checkerboard under a strong perspective warp, rendered by
 * the point-sampled TypeScript engine and by the WASM engine's Ultra path
 * (adaptive supersampling). The compressed region aliases into moiré with
 * point sampling and averages to smooth gray with supersampling.
 *
 * Run: npx vitest run --config vitest.figure.config.ts
 * Output: out/quality-ts.png and out/quality-wasm.png (gitignored).
 */
import { test, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsOptimizedRender } from './src/tsOptimized';
import { encodePng } from './src/png';
import { initSync, create_session, render_final, destroy_session } from './engine/transformer_engine.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(ROOT, 'out');

const SIZE = 1536;
/** Checker cell in px — fine enough to go sub-pixel under compression. */
const CHECKER = 2;
const PARAMS = { yawDeg: 55, pitchDeg: -30, rollDeg: 0, fovDeg: 50, distance: 0.7, fitMode: 'contain' as const };

function checkerboard(size: number): { rgba: ArrayBuffer; w: number; h: number } {
  const buf = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = ((x / CHECKER) | 0) % 2 === ((y / CHECKER) | 0) % 2;
      const i = (y * size + x) * 4;
      const v = on ? 235 : 40;
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = 255;
    }
  }
  return { rgba: buf.buffer as ArrayBuffer, w: size, h: size };
}

test('generate quality figure sources', () => {
  mkdirSync(OUT_DIR, { recursive: true });
  const src = checkerboard(SIZE);

  // Point-sampled bilinear at full output resolution (what fast plugins do).
  const ts = tsOptimizedRender(src.rgba, src.w, src.h, PARAMS, SIZE);
  writeFileSync(path.join(OUT_DIR, 'quality-ts.png'), encodePng(new Uint8Array(ts.rgba), ts.width, ts.height));

  // The engine's Ultra render (adaptive supersampling + premultiplied alpha).
  initSync({ module: readFileSync(path.join(ROOT, 'engine', 'transformer_engine_bg.wasm')) });
  const srcPng = encodePng(new Uint8Array(src.rgba), src.w, src.h);
  const sid = create_session(srcPng);
  const out = render_final(sid, JSON.stringify(PARAMS), 'png', 90);
  destroy_session(sid);
  const dv = new DataView(out.buffer, out.byteOffset, 8);
  const w = dv.getUint32(0, true), h = dv.getUint32(4, true);
  writeFileSync(path.join(OUT_DIR, 'quality-wasm.png'), Buffer.from(out.subarray(8)));
  console.log('ts out', ts.width, 'x', ts.height, '| wasm out', w, 'x', h);
  expect(ts.width).toBeGreaterThan(0);
});
