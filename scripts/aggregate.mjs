#!/usr/bin/env node
/**
 * aggregate.mjs — build results/canonical.json from N full bench runs.
 *
 * Input:  results/runs/run-*.json (each a full `npm run bench` output,
 *         saved from results/js-wasm.json after every run).
 * Output: results/canonical.json — for every case (group/engine/size) the
 *         MEDIAN of the per-run medianMs values, plus the spread
 *         (min..max of the run medians). Derived ratios for Group A are
 *         computed run-paired (each run's tsX median / that run's wasm
 *         median) so spread reflects same-run conditions.
 *
 * An existing "scalarWasm" block in canonical.json (written by
 * scripts/scalar-probe.mjs) is preserved across re-aggregation.
 *
 * Usage: node scripts/aggregate.mjs
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUNS_DIR = path.join(ROOT, 'results', 'runs');
const OUT_PATH = path.join(ROOT, 'results', 'canonical.json');

const round4 = (x) => Math.round(x * 10000) / 10000;
const round3 = (x) => Math.round(x * 1000) / 1000;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ── Load runs ──────────────────────────────────────────────────────

const runFiles = readdirSync(RUNS_DIR)
  .filter((f) => /^run-\d+\.json$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

if (runFiles.length === 0) {
  console.error(`No run-*.json files in ${RUNS_DIR}`);
  process.exit(1);
}

const runs = runFiles.map((f) => ({
  file: `runs/${f}`,
  data: JSON.parse(readFileSync(path.join(RUNS_DIR, f), 'utf8')),
}));

// Machine info must be identical across runs — refuse to mix machines.
const machineKey = (m) => `${m.cpuModel}/${m.cores}/${m.node}/${m.platform}`;
const machine = runs[0].data.machine;
for (const r of runs) {
  if (machineKey(r.data.machine) !== machineKey(machine)) {
    console.error(`Machine mismatch in ${r.file}: ${machineKey(r.data.machine)}`);
    process.exit(1);
  }
}

// ── Aggregate cases ────────────────────────────────────────────────

const caseKey = (c) => `${c.group}/${c.engine}/${c.size}`;
const byKey = new Map();

for (const r of runs) {
  for (const c of r.data.cases) {
    const key = caseKey(c);
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { meta: c, medians: [], colds: [] };
      byKey.set(key, bucket);
    }
    if (
      bucket.meta.iterations !== c.iterations ||
      bucket.meta.outW !== c.outW ||
      bucket.meta.outH !== c.outH
    ) {
      console.error(`Inconsistent case meta across runs for ${key}`);
      process.exit(1);
    }
    bucket.medians.push(c.medianMs);
    if (c.coldMs !== undefined) bucket.colds.push(c.coldMs);
  }
}

const cases = [...byKey.values()].map(({ meta, medians, colds }) => {
  const out = {
    group: meta.group,
    engine: meta.engine,
    size: meta.size,
    maxSide: meta.maxSide,
    quality: meta.quality,
    iterationsPerRun: meta.iterations,
    runs: medians.length,
    medianMs: round4(median(medians)),
    spreadMinMs: round4(Math.min(...medians)),
    spreadMaxMs: round4(Math.max(...medians)),
    runMediansMs: medians.map(round4),
    outW: meta.outW,
    outH: meta.outH,
  };
  if (colds.length > 0) {
    out.coldMedianMs = round4(median(colds));
    out.coldSpreadMinMs = round4(Math.min(...colds));
    out.coldSpreadMaxMs = round4(Math.max(...colds));
    out.coldRunMs = colds.map(round4);
  }
  return out;
});

cases.sort(
  (a, b) =>
    a.group.localeCompare(b.group) || a.size - b.size || a.engine.localeCompare(b.engine),
);

const findCase = (group, engine, size) =>
  cases.find((c) => c.group === group && c.engine === engine && c.size === size);

// ── Derived Group A ratios (run-paired) ────────────────────────────

const intervalsOverlap = (aMin, aMax, bMin, bMax) => aMin <= bMax && bMin <= aMax;

const groupASizes = [...new Set(cases.filter((c) => c.group === 'A').map((c) => c.size))].sort(
  (a, b) => a - b,
);

const groupA = groupASizes.map((size) => {
  const naive = findCase('A', 'ts-naive', size);
  const opt = findCase('A', 'ts-optimized', size);
  const wasm = findCase('A', 'wasm-draft', size);
  const paired = (top) => {
    const perRun = top.runMediansMs.map((m, i) => round3(m / wasm.runMediansMs[i]));
    return {
      ratioOfMedians: round3(top.medianMs / wasm.medianMs),
      spreadMin: Math.min(...perRun),
      spreadMax: Math.max(...perRun),
      perRunRatios: perRun,
    };
  };
  return {
    size,
    tsNaiveOverWasm: paired(naive),
    tsOptimizedOverWasm: paired(opt),
    tsOptimizedVsWasmSpreadOverlap: intervalsOverlap(
      opt.spreadMinMs,
      opt.spreadMaxMs,
      wasm.spreadMinMs,
      wasm.spreadMaxMs,
    ),
  };
});

// ── Derived Group B/C/D convenience blocks ─────────────────────────

const pick = (c) =>
  c && {
    medianMs: c.medianMs,
    spreadMinMs: c.spreadMinMs,
    spreadMaxMs: c.spreadMaxMs,
  };

const groupB = [2048, 4096].map((size) => {
  const draft = findCase('B', 'wasm-draft', size);
  return {
    source: size,
    maxSide: 1024,
    tsNaive: pick(findCase('B', 'ts-naive', size)),
    tsOptimized: pick(findCase('B', 'ts-optimized', size)),
    wasmDraftWarm: pick(draft),
    wasmDraftCold: draft && {
      medianMs: draft.coldMedianMs,
      spreadMinMs: draft.coldSpreadMinMs,
      spreadMaxMs: draft.coldSpreadMaxMs,
    },
    wasmUltra: pick(findCase('B', 'wasm-ultra', size)),
  };
});

const groupC = [1024, 2048, 4096].map((size) => ({
  size,
  wasmFinalPng: pick(findCase('C', 'wasm-final-png', size)),
}));

const groupD = { identityCheck2048: pick(findCase('D', 'wasm-identity', 2048)) };

// ── WASM init stats ────────────────────────────────────────────────

const initMsValues = runs.map((r) => r.data.wasm.initMs);
const wasm = {
  sizeBytes: runs[0].data.wasm.sizeBytes,
  initMedianMs: round4(median(initMsValues)),
  initSpreadMinMs: round4(Math.min(...initMsValues)),
  initSpreadMaxMs: round4(Math.max(...initMsValues)),
  initRunMs: initMsValues.map(round4),
};

// ── Preserve scalarWasm block from an earlier probe, if any ────────

let scalarWasm = null;
if (existsSync(OUT_PATH)) {
  try {
    scalarWasm = JSON.parse(readFileSync(OUT_PATH, 'utf8')).scalarWasm ?? null;
  } catch {
    /* unreadable previous canonical: drop */
  }
}

// ── Write ──────────────────────────────────────────────────────────

const canonical = {
  generatedAt: new Date().toISOString(),
  methodology:
    `${runs.length} full runs, median of run-medians, spread = min..max of run medians. ` +
    'Each run: full bench.test.ts (groups A,B,C,D,P), 2 untimed warmups per case, ' +
    'per-case iteration counts in iterationsPerRun. Runs executed sequentially with ' +
    '~10 s pauses, no other heavy load. Group A ratios are run-paired: per-run ratio = ' +
    "that run's tsX median / that run's wasm median; spread = min..max of per-run ratios.",
  machine,
  runTimestamps: runs.map((r) => r.data.timestamp),
  runFiles: runs.map((r) => r.file),
  wasm,
  cases,
  derived: { groupA, groupB, groupC, groupD },
  scalarWasm,
  parityNote:
    'Output parity data (ts vs wasm, convention analysis) is identical across runs; see results/js-wasm.json under parity.',
};

writeFileSync(OUT_PATH, JSON.stringify(canonical, null, 2) + '\n');
console.log(`Aggregated ${runs.length} runs -> ${OUT_PATH}`);

for (const g of groupA) {
  console.log(
    `  A ${String(g.size).padStart(4)}px  ts-opt/wasm=${g.tsOptimizedOverWasm.ratioOfMedians} ` +
      `(${g.tsOptimizedOverWasm.spreadMin}..${g.tsOptimizedOverWasm.spreadMax})  ` +
      `overlap=${g.tsOptimizedVsWasmSpreadOverlap}`,
  );
}
