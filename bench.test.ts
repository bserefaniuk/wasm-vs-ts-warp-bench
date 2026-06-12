/**
 * bench.test.ts
 *
 * Reproducible WASM-vs-TypeScript benchmark — standalone companion repo for
 * the article "WASM didn't make my Figma plugin faster. It made it possible."
 * Runs the compiled Rust/WASM engine of the 3D Image Transformer Figma plugin
 * and two TS baselines in plain Node (no Figma).
 *
 * Groups (filter with BENCH_GROUP=A,B,...):
 *   A — same algorithm, full-res bilinear warp size->size (ts-naive, ts-optimized, wasm-draft)
 *   B — production interactive frame, preview maxSide 1024 from full-res source
 *   C — apply path: wasm render_final PNG (ultra + SSAA + encode)
 *   D — identity short-circuit: is_identity_transform timing
 *   P — output parity: wasm render_preview(draft) vs tsOptimizedRender
 *
 * Output: results/js-wasm.json (+ sample PNGs). Partial runs merge
 * into the existing JSON so groups can be split across invocations.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';

import {
  create_session,
  destroy_session,
  initSync,
  is_identity_transform,
  render_final,
  render_preview,
} from './engine/transformer_engine.js';
import { tsBaselineRender, type TransformParams } from './src/tsBaseline';
import { computeInverseWarp, tsOptimizedRender } from './src/tsOptimized';
import { encodePng } from './src/png';

// ── Constants ──────────────────────────────────────────────────────

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(BENCH_DIR, 'results');
const RESULTS_PATH = path.join(RESULTS_DIR, 'js-wasm.json');
const WASM_PATH = path.join(BENCH_DIR, 'engine/transformer_engine_bg.wasm');

const WARP_PARAMS: TransformParams = {
  yawDeg: 25,
  pitchDeg: -15,
  rollDeg: 3,
  fovDeg: 50,
  distance: 1.5,
  fitMode: 'contain',
};
const WARP_JSON = JSON.stringify(WARP_PARAMS);

const IDENTITY_PARAMS: TransformParams = {
  yawDeg: 0,
  pitchDeg: 0,
  rollDeg: 0,
  fovDeg: 45,
  distance: 1.5,
  fitMode: 'contain',
};

const GROUPS = (process.env.BENCH_GROUP ?? 'A,B,C,D,P').toUpperCase().split(',');
const IS_PARTIAL = process.env.BENCH_GROUP !== undefined;
const WARMUP = 2;

// ── Result accumulation ────────────────────────────────────────────

interface CaseRecord {
  group: string;
  engine: string;
  size: number;
  maxSide: number;
  quality: string | null;
  iterations: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  coldMs?: number;
  outW: number;
  outH: number;
}

/** Channel-level diff statistics between two equally-sized RGBA buffers. */
interface DiffStats {
  maxAbsDiff: number;
  meanAbsDiff: number;
  pctOver2: number;
}

interface ParityCase {
  size: number;
  raw: DiffStats;
  adjusted?: {
    sampleOffsetPlus05: DiffStats;
    sampleOffsetMinus05: DiffStats;
    engineConvention: DiffStats;
    /** Residual >8 diffs under the engine convention: where do they live? */
    engineConventionResidual: {
      pixelsOver8: number;
      pctOnPartialAlphaEdge: number;
    };
  };
}

const cases: CaseRecord[] = [];
const notes: string[] = [];
let parityMaxDiff = -1;
let parityWasmCases: ParityCase[] | null = null;
let parityWasmNote: string | null = null;
let wasmInitMs = -1;
let wasmReady = false;

/** Round to 4 decimals — identity checks run in the microsecond range. */
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface Stats {
  iterations: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
}

function timeIt(fn: () => void, iterations: number, warmup = WARMUP): Stats {
  for (let i = 0; i < warmup; i++) fn();
  const timings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    timings.push(performance.now() - t0);
  }
  return {
    iterations,
    medianMs: round4(median(timings)),
    minMs: round4(Math.min(...timings)),
    maxMs: round4(Math.max(...timings)),
    meanMs: round4(timings.reduce((a, b) => a + b, 0) / timings.length),
  };
}

function logCase(c: CaseRecord): void {
  const cold = c.coldMs !== undefined ? `  cold=${c.coldMs}ms` : '';
  console.log(
    `  ${c.group}  ${c.engine.padEnd(14)} ${String(c.size).padStart(4)}px  maxSide=${String(c.maxSide).padStart(4)}  ` +
      `${(c.quality ?? '-').padEnd(5)}  n=${String(c.iterations).padStart(2)}  ` +
      `median=${String(c.medianMs).padStart(9)}ms  min=${String(c.minMs).padStart(9)}ms  ` +
      `max=${String(c.maxMs).padStart(9)}ms  out=${c.outW}x${c.outH}${cold}`,
  );
}

// ── Test image + WASM session plumbing ─────────────────────────────

/** Grey background rgb(100,130,170), white grid line every 64 px, opaque. */
function createTestImage(size: number): Uint8Array {
  const buf = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const isGridRow = y % 64 === 0;
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      if (isGridRow || x % 64 === 0) {
        buf[idx] = 255;
        buf[idx + 1] = 255;
        buf[idx + 2] = 255;
      } else {
        buf[idx] = 100;
        buf[idx + 1] = 130;
        buf[idx + 2] = 170;
      }
      buf[idx + 3] = 255;
    }
  }
  return buf;
}

const imageCache = new Map<number, Uint8Array>();
const pngCache = new Map<number, Uint8Array>();
const sharedSessions = new Map<number, number>();

function testImage(size: number): Uint8Array {
  let img = imageCache.get(size);
  if (!img) {
    img = createTestImage(size);
    imageCache.set(size, img);
  }
  return img;
}

function testPng(size: number): Uint8Array {
  let png = pngCache.get(size);
  if (!png) {
    png = encodePng(testImage(size), size, size);
    pngCache.set(size, png);
  }
  return png;
}

function ensureWasm(): void {
  if (wasmReady) return;
  const wasmBytes = readFileSync(WASM_PATH);
  const t0 = performance.now();
  initSync({ module: wasmBytes });
  wasmInitMs = round4(performance.now() - t0);
  wasmReady = true;
  console.log(`  wasm init: ${wasmInitMs}ms (${wasmBytes.length} bytes)`);
}

/** Shared session per size (groups A/C/D — no preview base required). */
function sharedSession(size: number): number {
  let id = sharedSessions.get(size);
  if (id === undefined) {
    id = create_session(testPng(size));
    expect(typeof id).toBe('number'); // create_session accepted bench/png.ts output
    sharedSessions.set(size, id);
  }
  return id;
}

function parsePreviewHeader(buf: Uint8Array): { w: number; h: number; body: Uint8Array } {
  const view = new DataView(buf.buffer, buf.byteOffset, 8);
  return { w: view.getUint32(0, true), h: view.getUint32(4, true), body: buf.subarray(8) };
}

// ── Parity gate (always runs, before any timing) ───────────────────

it('parity: ts-optimized matches ts-baseline within 2/channel on 128x128', () => {
  const size = 128;
  const img = testImage(size);
  const base = tsBaselineRender(img.buffer as ArrayBuffer, size, size, WARP_PARAMS, size);
  const opt = tsOptimizedRender(img.buffer as ArrayBuffer, size, size, WARP_PARAMS, size);

  expect(opt.width).toBe(base.width);
  expect(opt.height).toBe(base.height);

  const a = new Uint8Array(base.rgba);
  const b = new Uint8Array(opt.rgba);
  let maxDiff = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxDiff) maxDiff = d;
  }
  parityMaxDiff = maxDiff;
  console.log(`  parity maxChannelDiff = ${maxDiff}`);
  expect(maxDiff).toBeLessThanOrEqual(2);
});

// ── Group A: same algorithm, full-res bilinear warp size->size ─────

it.runIf(GROUPS.includes('A'))('Group A: full-res bilinear warp (language vs language)', () => {
  ensureWasm();
  console.log('\nGroup A — same algorithm, full-res bilinear warp size->size');

  for (const size of [512, 1024, 2048, 4096]) {
    const iters = size <= 1024 ? 10 : 5;
    const img = testImage(size);
    const src = img.buffer as ArrayBuffer;

    let naiveOut = { width: 0, height: 0, rgba: new ArrayBuffer(0) };
    const naive = timeIt(() => {
      naiveOut = tsBaselineRender(src, size, size, WARP_PARAMS, size);
    }, iters);
    const cNaive: CaseRecord = {
      group: 'A', engine: 'ts-naive', size, maxSide: size, quality: null,
      ...naive, outW: naiveOut.width, outH: naiveOut.height,
    };
    cases.push(cNaive);
    logCase(cNaive);

    let optOut = { width: 0, height: 0, rgba: new ArrayBuffer(0) };
    const opt = timeIt(() => {
      optOut = tsOptimizedRender(src, size, size, WARP_PARAMS, size);
    }, iters);
    const cOpt: CaseRecord = {
      group: 'A', engine: 'ts-optimized', size, maxSide: size, quality: null,
      ...opt, outW: optOut.width, outH: optOut.height,
    };
    cases.push(cOpt);
    logCase(cOpt);

    if (size === 1024) {
      // Visual sanity sample: ts-optimized output encoded with bench/png.ts
      mkdirSync(RESULTS_DIR, { recursive: true });
      writeFileSync(
        path.join(RESULTS_DIR, 'sample-ts-1024.png'),
        encodePng(new Uint8Array(optOut.rgba), optOut.width, optOut.height),
      );
    }

    const sid = sharedSession(size);
    let wasmOut = { w: 0, h: 0 };
    const wasm = timeIt(() => {
      const res = parsePreviewHeader(render_preview(sid, WARP_JSON, size, 'draft'));
      wasmOut = { w: res.w, h: res.h };
    }, iters);
    const cWasm: CaseRecord = {
      group: 'A', engine: 'wasm-draft', size, maxSide: size, quality: 'draft',
      ...wasm, outW: wasmOut.w, outH: wasmOut.h,
    };
    cases.push(cWasm);
    logCase(cWasm);

    // Output dims must match across all three engines
    expect(optOut.width).toBe(naiveOut.width);
    expect(optOut.height).toBe(naiveOut.height);
    expect(wasmOut.w).toBe(naiveOut.width);
    expect(wasmOut.h).toBe(naiveOut.height);
  }
});

// ── Group B: production interactive frame (preview maxSide 1024) ───

it.runIf(GROUPS.includes('B'))('Group B: interactive preview frame, maxSide 1024', () => {
  ensureWasm();
  console.log('\nGroup B — production interactive frame, preview maxSide 1024, steady state');
  const MAX_SIDE = 1024;
  const ITERS = 10;

  for (const size of [2048, 4096]) {
    const img = testImage(size);
    const src = img.buffer as ArrayBuffer;

    let naiveOut = { width: 0, height: 0 };
    const naive = timeIt(() => {
      const r = tsBaselineRender(src, size, size, WARP_PARAMS, MAX_SIDE);
      naiveOut = { width: r.width, height: r.height };
    }, ITERS);
    const cNaive: CaseRecord = {
      group: 'B', engine: 'ts-naive', size, maxSide: MAX_SIDE, quality: null,
      ...naive, outW: naiveOut.width, outH: naiveOut.height,
    };
    cases.push(cNaive);
    logCase(cNaive);

    let optOut = { width: 0, height: 0 };
    const opt = timeIt(() => {
      const r = tsOptimizedRender(src, size, size, WARP_PARAMS, MAX_SIDE);
      optOut = { width: r.width, height: r.height };
    }, ITERS);
    const cOpt: CaseRecord = {
      group: 'B', engine: 'ts-optimized', size, maxSide: MAX_SIDE, quality: null,
      ...opt, outW: optOut.width, outH: optOut.height,
    };
    cases.push(cOpt);
    logCase(cOpt);

    // Fresh session so the first preview call is a true cold frame
    // (builds the ultra-quality downscaled preview base, then reuses it).
    const sid = create_session(testPng(size));
    const tCold = performance.now();
    render_preview(sid, WARP_JSON, MAX_SIDE, 'draft');
    const coldMs = round4(performance.now() - tCold);

    let draftOut = { w: 0, h: 0 };
    const draft = timeIt(() => {
      const r = parsePreviewHeader(render_preview(sid, WARP_JSON, MAX_SIDE, 'draft'));
      draftOut = { w: r.w, h: r.h };
    }, ITERS);
    const cDraft: CaseRecord = {
      group: 'B', engine: 'wasm-draft', size, maxSide: MAX_SIDE, quality: 'draft',
      ...draft, coldMs, outW: draftOut.w, outH: draftOut.h,
    };
    cases.push(cDraft);
    logCase(cDraft);

    let ultraOut = { w: 0, h: 0 };
    const ultra = timeIt(() => {
      const r = parsePreviewHeader(render_preview(sid, WARP_JSON, MAX_SIDE, 'ultra'));
      ultraOut = { w: r.w, h: r.h };
    }, ITERS);
    const cUltra: CaseRecord = {
      group: 'B', engine: 'wasm-ultra', size, maxSide: MAX_SIDE, quality: 'ultra',
      ...ultra, outW: ultraOut.w, outH: ultraOut.h,
    };
    cases.push(cUltra);
    logCase(cUltra);

    destroy_session(sid);
  }
});

// ── Group C: apply path (render_final ultra + SSAA + PNG encode) ───

it.runIf(GROUPS.includes('C'))('Group C: apply path, wasm render_final png', () => {
  ensureWasm();
  console.log('\nGroup C — apply path: render_final "png" (ultra + SSAA + encode)');
  const ITERS = 5;

  for (const size of [1024, 2048, 4096]) {
    const sid = sharedSession(size);
    let out: { w: number; h: number; body: Uint8Array } = { w: 0, h: 0, body: new Uint8Array(0) };
    const stats = timeIt(() => {
      out = parsePreviewHeader(render_final(sid, WARP_JSON, 'png', 90));
    }, ITERS);
    const c: CaseRecord = {
      group: 'C', engine: 'wasm-final-png', size, maxSide: 0, quality: 'ultra',
      ...stats, outW: out.w, outH: out.h,
    };
    cases.push(c);
    logCase(c);

    if (size === 1024) {
      // Visual sanity sample: render_final body is already encoded PNG
      mkdirSync(RESULTS_DIR, { recursive: true });
      writeFileSync(path.join(RESULTS_DIR, 'sample-wasm-1024.png'), out.body);
    }
  }
});

// ── Group P: wasm vs ts-optimized output parity ────────────────────

function diffStats(a: Uint8Array, b: Uint8Array): DiffStats {
  if (a.length !== b.length) throw new Error(`diffStats: length mismatch ${a.length} vs ${b.length}`);
  let maxD = 0;
  let sum = 0;
  let over2 = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxD) maxD = d;
    sum += d;
    if (d > 2) over2++;
  }
  return {
    maxAbsDiff: maxD,
    meanAbsDiff: round4(sum / a.length),
    pctOver2: round4((over2 / a.length) * 100),
  };
}

/**
 * Re-run the ts-optimized bilinear warp with explicit pixel-center offsets,
 * to probe whether a large wasm/ts diff is only a sampling-convention shift.
 * Destination coords are mapped at (dx + dstOffset, dy + dstOffset) through
 * hInv and sampleOffset is added to the resulting source position. The wasm
 * engine's convention is dstOffset=+0.5, sampleOffset=-0.5 (it maps dst
 * pixel CENTERS and subtracts the half pixel on the source side, tile.rs);
 * tsOptimizedRender is dstOffset=0, sampleOffset=0.
 */
function tsWarpWithOffsets(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  hInv: Float64Array,
  outW: number,
  outH: number,
  dstOffset: number,
  sampleOffset: number,
): Uint8Array {
  const h0 = hInv[0], h1 = hInv[1], h2 = hInv[2];
  const h3 = hInv[3], h4 = hInv[4], h5 = hInv[5];
  const h6 = hInv[6], h7 = hInv[7], h8 = hInv[8];
  const out = new Uint8Array(outW * outH * 4);
  const stride = srcWidth * 4;
  let outIdx = 0;

  for (let dy = 0; dy < outH; dy++) {
    const yc = dy + dstOffset;
    for (let dx = 0; dx < outW; dx++, outIdx += 4) {
      const xc = dx + dstOffset;
      const w = h6 * xc + h7 * yc + h8;
      if (w < 1e-12 && w > -1e-12) continue;
      const sx = (h0 * xc + h1 * yc + h2) / w + sampleOffset;
      const sy = (h3 * xc + h4 * yc + h5) / w + sampleOffset;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = x0 + 1;
      const y1 = y0 + 1;
      if (x1 < 0 || y1 < 0 || x0 >= srcWidth || y0 >= srcHeight) continue;
      const fx = sx - x0;
      const fy = sy - y0;

      const x0in = x0 >= 0 && x0 < srcWidth;
      const x1in = x1 >= 0 && x1 < srcWidth;
      const y0in = y0 >= 0 && y0 < srcHeight;
      const y1in = y1 >= 0 && y1 < srcHeight;

      let r00 = 0, g00 = 0, b00 = 0, a00 = 0;
      let r10 = 0, g10 = 0, b10 = 0, a10 = 0;
      let r01 = 0, g01 = 0, b01 = 0, a01 = 0;
      let r11 = 0, g11 = 0, b11 = 0, a11 = 0;
      if (y0in) {
        const row = y0 * stride;
        if (x0in) { const i = row + x0 * 4; r00 = src[i]; g00 = src[i + 1]; b00 = src[i + 2]; a00 = src[i + 3]; }
        if (x1in) { const i = row + x1 * 4; r10 = src[i]; g10 = src[i + 1]; b10 = src[i + 2]; a10 = src[i + 3]; }
      }
      if (y1in) {
        const row = y1 * stride;
        if (x0in) { const i = row + x0 * 4; r01 = src[i]; g01 = src[i + 1]; b01 = src[i + 2]; a01 = src[i + 3]; }
        if (x1in) { const i = row + x1 * 4; r11 = src[i]; g11 = src[i + 1]; b11 = src[i + 2]; a11 = src[i + 3]; }
      }

      const rt = r00 + (r10 - r00) * fx, rb = r01 + (r11 - r01) * fx;
      const gt = g00 + (g10 - g00) * fx, gb = g01 + (g11 - g01) * fx;
      const bt = b00 + (b10 - b00) * fx, bb = b01 + (b11 - b01) * fx;
      const at = a00 + (a10 - a00) * fx, ab = a01 + (a11 - a01) * fx;

      out[outIdx] = (rt + (rb - rt) * fy + 0.5) | 0;
      out[outIdx + 1] = (gt + (gb - gt) * fy + 0.5) | 0;
      out[outIdx + 2] = (bt + (bb - bt) * fy + 0.5) | 0;
      out[outIdx + 3] = (at + (ab - at) * fy + 0.5) | 0;
    }
  }
  return out;
}

const logDiff = (label: string, d: DiffStats): string =>
  `${label}: max=${d.maxAbsDiff} mean=${d.meanAbsDiff} >2=${d.pctOver2}%`;

it.runIf(GROUPS.includes('P'))('Group P: wasm draft vs ts-optimized output parity', () => {
  ensureWasm();
  console.log('\nGroup P — output parity, wasm render_preview(draft) vs tsOptimizedRender');
  const results: ParityCase[] = [];

  for (const size of [256, 512]) {
    const img = testImage(size);
    const ts = tsOptimizedRender(img.buffer as ArrayBuffer, size, size, WARP_PARAMS, size);
    const wasm = parsePreviewHeader(render_preview(sharedSession(size), WARP_JSON, size, 'draft'));

    expect(wasm.w).toBe(ts.width);
    expect(wasm.h).toBe(ts.height);

    const raw = diffStats(new Uint8Array(ts.rgba), wasm.body);
    const entry: ParityCase = { size, raw };
    console.log(`  P  ${String(size).padStart(4)}px  ${logDiff('raw', raw)}`);

    if (raw.maxAbsDiff > 8) {
      const hInv = computeInverseWarp(size, size, WARP_PARAMS, ts.width, ts.height);
      const probe = (dstOff: number, smpOff: number): Uint8Array =>
        tsWarpWithOffsets(img, size, size, hInv, ts.width, ts.height, dstOff, smpOff);
      const engineConvPixels = probe(0.5, -0.5);

      // Residual localization: per-pixel max channel diff > 8 under the
      // engine convention — count and classify by alpha (quad edge vs interior).
      let pixelsOver8 = 0;
      let onEdge = 0;
      for (let p = 0; p < engineConvPixels.length; p += 4) {
        let d = 0;
        for (let c = 0; c < 4; c++) {
          const dc = Math.abs(engineConvPixels[p + c] - wasm.body[p + c]);
          if (dc > d) d = dc;
        }
        if (d > 8) {
          pixelsOver8++;
          if (engineConvPixels[p + 3] < 255 || wasm.body[p + 3] < 255) onEdge++;
        }
      }

      entry.adjusted = {
        sampleOffsetPlus05: diffStats(probe(0, 0.5), wasm.body),
        sampleOffsetMinus05: diffStats(probe(0, -0.5), wasm.body),
        engineConvention: diffStats(engineConvPixels, wasm.body),
        engineConventionResidual: {
          pixelsOver8,
          pctOnPartialAlphaEdge: pixelsOver8 === 0 ? 0 : round4((onEdge / pixelsOver8) * 100),
        },
      };
      console.log(`       ${logDiff('adj sample+0.5', entry.adjusted.sampleOffsetPlus05)}`);
      console.log(`       ${logDiff('adj sample-0.5', entry.adjusted.sampleOffsetMinus05)}`);
      console.log(`       ${logDiff('adj engine-convention (dst+0.5, sample-0.5)', entry.adjusted.engineConvention)}`);
      console.log(
        `       residual: ${pixelsOver8} px over 8, ${entry.adjusted.engineConventionResidual.pctOnPartialAlphaEdge}% on partial-alpha quad edges`,
      );
    }
    results.push(entry);
  }

  parityWasmCases = results;
  parityWasmNote =
    'Raw diff compares tsOptimizedRender output to wasm render_preview draft (8-byte header stripped) on the standard warp params. The two engines use different pixel-center conventions: wasm maps destination pixel centers (x+0.5, y+0.5) through the inverse homography and subtracts 0.5 from the sampled source position (render/tile.rs), while the TS engines map raw integer coordinates with no offsets. When raw max diff exceeds 8, "adjusted" re-runs the TS warp with sample offsets +/-0.5 and with the exact engine convention (dst +0.5, sample -0.5) to separate convention shift from genuine numeric divergence. engineConventionResidual then localizes the surviving >8 diffs: they sit on partial-alpha quad-edge pixels, where wasm interpolates premultiplied alpha and resolves while the TS engines interpolate straight alpha.';
});

// ── Group D: identity short-circuit ────────────────────────────────

it.runIf(GROUPS.includes('D'))('Group D: identity short-circuit check', () => {
  ensureWasm();
  console.log('\nGroup D — identity short-circuit, is_identity_transform on 2048');
  const size = 2048;
  const ITERS = 20;
  const sid = sharedSession(size);
  const idJson = JSON.stringify(IDENTITY_PARAMS);

  let isIdentity = false;
  const stats = timeIt(() => {
    isIdentity = is_identity_transform(sid, idJson);
  }, ITERS);
  expect(isIdentity).toBe(true);

  const c: CaseRecord = {
    group: 'D', engine: 'wasm-identity', size, maxSide: 0, quality: null,
    ...stats, outW: size, outH: size,
  };
  cases.push(c);
  logCase(c);
});

// ── Write merged results ───────────────────────────────────────────

afterAll(() => {
  for (const [, id] of sharedSessions) destroy_session(id);

  notes.push(
    'Group A times the identical algorithm class in all three engines: bilinear inverse warp at full source resolution (wasm-draft via render_preview with maxSide = source side; no preview base, no supersampling).',
    'Group B TS engines warp the full-res source down to a 1024 frame every call; wasm warm frames warp a cached prefiltered 1024 preview base (production interactive path). coldMs on wasm-draft is the first call that builds that base with an ultra-quality downscale.',
    'Group C has no TS counterpart: the naive TS renderer cannot do Jacobian-driven adaptive supersampling or PNG encoding; render_final does strictly more work (ultra bicubic + SSAA + premultiplied alpha + PNG encode).',
    'Group D: production skips render AND encode entirely on identity and reuses the original encoded bytes bit-exact; the timed call is only the identity detection itself. outW/outH are the untouched source dims.',
    'Iterations actually used: Group A 10 (512/1024) and 5 (2048/4096); Group B 10; Group C 5; Group D 20. Warmup 2 untimed iterations per case.',
    'Source RGBA buffers are reused across iterations (renderers do not mutate input); timings include JS<->WASM boundary copies, as production pays them too.',
  );

  const wasmSizeBytes = existsSync(WASM_PATH) ? readFileSync(WASM_PATH).length : 0;

  let merged: CaseRecord[] = cases;
  let mergedNotes: string[] = notes;
  let prevParityWasm: unknown = null;
  if (IS_PARTIAL && existsSync(RESULTS_PATH)) {
    try {
      const prev = JSON.parse(readFileSync(RESULTS_PATH, 'utf8'));
      const kept = (prev.cases ?? []).filter((c: CaseRecord) => !GROUPS.includes(c.group));
      merged = [...kept, ...cases].sort(
        (a, b) => a.group.localeCompare(b.group) || a.size - b.size,
      );
      mergedNotes = [...new Set([...(prev.notes ?? []), ...notes])];
      prevParityWasm = prev.parity?.wasmVsTsOptimized ?? null;
    } catch {
      // unreadable previous file: overwrite with current run only
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    machine: {
      cpuModel: os.cpus()[0].model,
      cores: os.cpus().length,
      node: process.version,
      platform: process.platform,
    },
    wasm: { initMs: wasmInitMs, sizeBytes: wasmSizeBytes },
    cases: merged,
    parity: {
      maxChannelDiff: parityMaxDiff,
      wasmVsTsOptimized: parityWasmCases
        ? { params: WARP_PARAMS, quality: 'draft', cases: parityWasmCases, note: parityWasmNote }
        : prevParityWasm,
    },
    notes: mergedNotes,
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2) + '\n');

  console.log('\n=== FINAL TABLE (all recorded cases) ===');
  for (const c of merged) logCase(c);
  console.log(`\nResults written to ${RESULTS_PATH}`);
});
