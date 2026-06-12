#!/usr/bin/env node
/**
 * scalar-probe.mjs — one-off datapoint: how much does simd128 buy?
 *
 * Loads BOTH engine builds in one process — the shipped simd128 wasm from
 * engine/ and a scalar (no-simd128) rebuild of the same crate (wasm-pack
 * output directory given via the required SCALAR_PKG env var) —
 * and times the Group A wasm-draft cases with the identical harness
 * methodology: render_preview(draft) at maxSide = source side, 2 untimed
 * warmups, 5 timed iterations, median. 3 runs, alternating simd/scalar
 * within each run; recorded value is the median of the 3 run-medians
 * (spread = min..max). Timing both builds in the same process removes the
 * vitest-vs-plain-node harness delta from the comparison.
 *
 * Results are written into results/canonical.json under "scalarWasm".
 * Run scripts/aggregate.mjs first (the block also cites the canonical
 * vitest-run simd medians for context).
 *
 * NOTE: this probe needs the engine crate rebuilt WITHOUT simd128, which
 * requires the private Rust source — it is an author-only datapoint. The
 * recorded results (plus both builds' sha256) live in results/canonical.json
 * under "scalarWasm" for verification.
 *
 * Usage: SCALAR_PKG=/path/to/pkg-nosimd node scripts/scalar-probe.mjs
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CANONICAL_PATH = path.join(ROOT, 'results', 'canonical.json');
const SHIPPED_DIR = path.join(ROOT, 'engine');
const PKG_DIR = process.env.SCALAR_PKG;
if (!PKG_DIR) {
  console.error(
    'SCALAR_PKG is not set. This probe times a scalar (no-simd128) rebuild of\n' +
    'the engine crate, which requires the private Rust source. The recorded\n' +
    'results live in results/canonical.json under "scalarWasm".\n\n' +
    'Usage: SCALAR_PKG=/path/to/pkg-nosimd node scripts/scalar-probe.mjs',
  );
  process.exit(1);
}

const SIZES = [512, 1024, 2048, 4096];
const WARMUP = 2;
const ITERS = 5;
const RUNS = 3;

const WARP_JSON = JSON.stringify({
  yawDeg: 25,
  pitchDeg: -15,
  rollDeg: 3,
  fovDeg: 50,
  distance: 1.5,
  fitMode: 'contain',
});

const round4 = (x) => Math.round(x * 10000) / 10000;
const round3 = (x) => Math.round(x * 1000) / 1000;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ── Test image + PNG encode (ports of bench.test.ts / src/png.ts) ──

/** Grey background rgb(100,130,170), white grid line every 64 px, opaque. */
function createTestImage(size) {
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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length), false);
  return out;
}

function encodePng(rgba, width, height) {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowBytes = width * 4;
  const raw = new Uint8Array(height * (1 + rowBytes));
  for (let y = 0; y < height; y++) {
    const rawPos = y * (1 + rowBytes);
    raw[rawPos] = 0;
    raw.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), rawPos + 1);
  }
  const idat = new Uint8Array(deflateSync(raw, { level: 6 }));

  const chunks = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
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

// ── Load both engines (separate wasm-bindgen glue module scopes) ───

async function loadEngine(dir) {
  const glue = await import(pathToFileURL(path.join(dir, 'transformer_engine.js')).href);
  const bytes = readFileSync(path.join(dir, 'transformer_engine_bg.wasm'));
  glue.initSync({ module: bytes });
  return { glue, bytes };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const simd = await loadEngine(SHIPPED_DIR);
const scalar = await loadEngine(PKG_DIR);

const scalarSha = sha256(scalar.bytes);
const shippedSha = sha256(simd.bytes);
if (scalarSha === shippedSha) {
  console.error('Scalar wasm is byte-identical to the shipped simd128 wasm — wrong build?');
  process.exit(1);
}
console.log(`scalar wasm:  ${scalar.bytes.length} bytes  sha256=${scalarSha.slice(0, 16)}…`);
console.log(`shipped wasm: ${simd.bytes.length} bytes  sha256=${shippedSha.slice(0, 16)}…`);

// ── Time Group A wasm-draft cases on both builds, alternating ──────

const sessions = new Map(); // `${label}/${size}` -> sid
for (const [label, eng] of [['simd', simd], ['scalar', scalar]]) {
  for (const size of SIZES) {
    sessions.set(`${label}/${size}`, eng.glue.create_session(encodePng(createTestImage(size), size, size)));
  }
}

const runMedians = { simd: new Map(SIZES.map((s) => [s, []])), scalar: new Map(SIZES.map((s) => [s, []])) };

function timeCase(eng, label, size) {
  const sid = sessions.get(`${label}/${size}`);
  const call = () => eng.glue.render_preview(sid, WARP_JSON, size, 'draft');
  for (let i = 0; i < WARMUP; i++) call();
  const timings = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = performance.now();
    call();
    timings.push(performance.now() - t0);
  }
  return round4(median(timings));
}

for (let run = 1; run <= RUNS; run++) {
  console.log(`run ${run}/${RUNS}`);
  for (const size of SIZES) {
    for (const [label, eng] of [['simd', simd], ['scalar', scalar]]) {
      const med = timeCase(eng, label, size);
      runMedians[label].get(size).push(med);
      console.log(`  ${label.padEnd(6)} wasm-draft ${String(size).padStart(4)}px  median=${med}ms`);
    }
  }
}

for (const [label, eng] of [['simd', simd], ['scalar', scalar]]) {
  for (const size of SIZES) eng.glue.destroy_session(sessions.get(`${label}/${size}`));
}

// ── Merge into canonical.json ──────────────────────────────────────

const canonical = JSON.parse(readFileSync(CANONICAL_PATH, 'utf8'));

const stats = (values) => ({
  medianMs: round4(median(values)),
  spreadMinMs: round4(Math.min(...values)),
  spreadMaxMs: round4(Math.max(...values)),
  runMediansMs: values,
});

const sizesOut = SIZES.map((size) => {
  const sc = stats(runMedians.scalar.get(size));
  const sd = stats(runMedians.simd.get(size));
  const canonicalSimd = canonical.cases.find(
    (c) => c.group === 'A' && c.engine === 'wasm-draft' && c.size === size,
  );
  return {
    size,
    scalar: sc,
    simdSameProcess: sd,
    canonicalSimdMedianMs: canonicalSimd?.medianMs ?? null,
    scalarOverSimdRatio: round3(sc.medianMs / sd.medianMs),
    simdSpeedupPct: round3(((sc.medianMs - sd.medianMs) / sc.medianMs) * 100),
  };
});

canonical.scalarWasm = {
  note:
    'Identical harness, simd128 disabled: same engine crate rebuilt with wasm-pack ' +
    '--release without -C target-feature=+simd128 (RUSTFLAGS env override; committed ' +
    '.cargo/config.toml untouched). Both builds timed in ONE plain-node process with ' +
    'the Group A wasm-draft methodology (render_preview draft at maxSide = source ' +
    'side, 2 warmups, 5 iterations, median), alternating simd/scalar — 3 runs, ' +
    'median of run-medians. simdSpeedupPct = (scalar - simd) / scalar * 100; ' +
    'negative means the scalar build was faster. canonicalSimdMedianMs is the ' +
    '7-run vitest canonical for context (vitest adds ~2-3% over plain node).',
  probedAt: new Date().toISOString(),
  scalarWasmSizeBytes: scalar.bytes.length,
  scalarWasmSha256: scalarSha,
  shippedWasmSizeBytes: simd.bytes.length,
  shippedWasmSha256: shippedSha,
  warmup: WARMUP,
  iterations: ITERS,
  runs: RUNS,
  sizes: sizesOut,
};

writeFileSync(CANONICAL_PATH, JSON.stringify(canonical, null, 2) + '\n');
console.log(`\nscalarWasm written to ${CANONICAL_PATH}`);
for (const s of sizesOut) {
  console.log(
    `  ${String(s.size).padStart(4)}px  scalar=${s.scalar.medianMs}ms  simd=${s.simdSameProcess.medianMs}ms  ` +
      `scalar/simd=${s.scalarOverSimdRatio}  simd buys ${s.simdSpeedupPct}%`,
  );
}
