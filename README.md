# wasm-vs-ts-warp-bench

Reproducible benchmark comparing a Rust/WASM 3D perspective image warp engine
against two pure-TypeScript implementations of the same algorithm, plus an
output-parity check between them.

Companion repo for the article **"WASM didn't make my Figma plugin faster. It
made it possible."** about the engine behind the 3D Image Transformer Figma
plugin. Everything runs in plain Node — no Figma, no browser.

## The three engines

**`src/tsBaseline.ts` (ts-naive)** is a straightforward, readable TypeScript
implementation of the full pipeline: camera rotation (yaw/pitch/roll),
perspective projection of the source quad, 4-point DLT homography with
Gaussian elimination, then an inverse-mapped bilinear warp. It is written the
way most application code gets written first — per-pixel function calls, tuple
allocations, clamping via `Math` calls — and serves as the correctness
reference and performance floor.

**`src/tsOptimized.ts` (ts-optimized)** is the same camera model and the same
output semantics, hand-optimized the way you would tune a JS hot loop: the
homography is applied inline in the pixel loop, there are zero per-pixel
allocations, all state lives in flat scalar locals over typed arrays. It
represents a realistic "we tried hard in TypeScript" ceiling, and it gets
within striking distance of WASM on the identical algorithm.

**`engine/transformer_engine_bg.wasm` (wasm)** is the compiled, production
Rust engine of the 3D Image Transformer Figma plugin (built with
`opt-level = 3`, LTO, SIMD128). Beyond the same bilinear draft warp it ships
the things the TS baselines don't have: a cached prefiltered preview base for
interactive frames, Jacobian-driven adaptive supersampling with bicubic
sampling for final quality, premultiplied-alpha interpolation, PNG/JPEG
decode/encode, and an identity short-circuit. The binary is included for
verification only — see [License](#license).

## How to run

```sh
npm install
npm run bench              # all groups (A, B, C, D, P), ~30-60 s
BENCH_GROUP=A npm run bench    # quick run: just the like-for-like warp
BENCH_GROUP=A,P npm run bench  # warp + parity
```

Results are written to `results/js-wasm.json`; partial (`BENCH_GROUP`) runs
merge into the existing file. `results/native.json` holds the same Rust engine
benchmarked natively (cargo, Apple Silicon) for context, and
`results/module-breakdown.md` is a twiggy size breakdown of the WASM binary.

Re-running overwrites `results/js-wasm.json` with *your* numbers (handy for
diffing against the committed ones). The canonical article dataset lives in
`results/runs/` + `results/canonical.json` and is never touched by
`npm run bench`.

**`results/canonical.json` is the canonical dataset** quoted by the article:
7 full sequential runs (saved as `results/runs/run-*.json`), aggregated with
`node scripts/aggregate.mjs` — for every case the **median of the 7 run-medians**
with the spread (min..max of the run medians). To reproduce the study: run
`npm run bench` 7 times, copying `results/js-wasm.json` to
`results/runs/run-N.json` after each run, then run the aggregator. The
simd128 probe (`scripts/scalar-probe.mjs`, see below) appends the
`scalarWasm` block.

Two extras: `npx vitest run --config vitest.figure.config.ts` regenerates the
article's quality before/after figure sources into `out/` (gitignored), and
`results/sample-*.png` are visual sanity renders from the two engine families
(written by the parity group).

## Headline results

Apple M4 Max, Node v24.14.0. All values are **median of 7 run-medians, in ms,
with (min–max) spread of the run medians**.

### Group A — identical algorithm, full-res bilinear warp (size → size)

| Source | ts-naive | ts-optimized | wasm (draft) | ts-opt / wasm |
|-------:|---------:|-------------:|-------------:|--------------:|
|  512px | 9.52 (9.40–10.44) | 2.94 (2.65–3.59) | 3.26 (3.21–3.29) | 0.90 (0.80–1.09) |
| 1024px | 53.3 (52.8–54.5) | 13.4 (11.6–15.7) | 12.9 (12.8–13.0) | 1.04 (0.90–1.22) |
| 2048px | 180.3 (180.1–183.4) | 53.2 (46.1–58.4) | 51.0 (50.7–51.3) | 1.04 (0.90–1.15) |
| 4096px | 721.0 (715.5–730.9) | 199.6 (178.9–229.9) | 196.6 (196.2–198.6) | 1.02 (0.90–1.17) |

Same bilinear inverse warp in all three. WASM is 2.9–4.1× the naive TS, but
against the hand-optimized TS it is a **statistical tie**: the ts-opt/wasm
ratio straddles 1.0 at every size and the spread intervals of the two engines
overlap at every size. What does separate them is run-to-run stability.
Measured as half-spread of the 7 run medians relative to the canonical
median: wasm stays within ±1.3% at every size, while ts-optimized swings by
±11.5–16.1% (single run medians deviate up to 22%). Same code, same machine,
warmups done.

### Group B — production interactive frame (preview maxSide 1024)

| Source | ts-naive | ts-optimized | wasm draft warm | wasm draft cold | wasm ultra |
|-------:|---------:|-------------:|----------------:|----------------:|-----------:|
| 2048px | 51.7 (50.0–54.6) | 14.1 (11.5–15.1) | 12.9 (12.8–13.1) | 64.2 (63.7–64.5) | 44.2 (43.8–44.5) |
| 4096px | 61.6 (59.1–62.4) | 21.9 (17.1–24.7) | 12.8 (12.7–13.0) | 194.4 (193.9–197.3) | 43.9 (43.4–44.9) |

TS engines re-warp the full-res source every frame; the wasm engine pays one
cold frame to build a prefiltered 1024 preview base, then every warm frame is
~12.9 ms regardless of source size — flat 60+ fps interaction where the TS
cost keeps growing with input size. To be clear about attribution: the warm-
frame win is the cached-base *architecture*, and a TS engine could adopt the
same design (Group A shows the per-frame warp itself is a tie). What the wasm
engine brings is the machinery that builds the base — the anti-aliased
prefilter and codecs — and the run-to-run stability of the frames.

### Does simd128 matter here? No — measured, not assumed

The shipped engine is built with `-C target-feature=+simd128`. Rebuilding the
identical crate **without** simd128 and timing both builds in one process with
the identical Group A methodology (`scripts/scalar-probe.mjs`, 3 runs, median
of run-medians) gives:

| Source | scalar wasm | simd128 wasm | simd gain |
|-------:|------------:|-------------:|----------:|
|  512px |        3.12 |         3.13 |     −0.2% |
| 1024px |       12.44 |        12.47 |     −0.2% |
| 2048px |       48.40 |        49.20 |     −1.7% |
| 4096px |      185.72 |       189.71 |     −2.1% |

simd128 buys nothing on this kernel — the scalar build is even marginally
faster (0.2–2.1%, noise-level but consistently ≤0). LLVM does not
auto-vectorize the gather-heavy bilinear warp loop, so the flag mostly
changes code layout; it also costs ~12 KB of module size. The draft-warp
speed parity with hand-optimized TS is therefore *not* a SIMD story either —
it is "both compile to tight scalar loops". Full numbers in
`results/canonical.json` under `scalarWasm`.

One honesty note: re-running this probe requires rebuilding the closed-source
crate without simd128, so it is an author-only datapoint — the scalar build's
sha256 and size are recorded in `canonical.json` for verification, and
`scripts/scalar-probe.mjs` documents the exact procedure.

### Parity — wasm draft output vs ts-optimized (Group P)

| Size | Comparison | Max abs diff | Mean abs diff | % values >2 |
|-----:|------------|-------------:|--------------:|------------:|
| 256px | raw | 255 | 1.70 | 3.92% |
| 256px | convention-adjusted | 252 | 0.79 | 0.89% |
| 512px | raw | 255 | 1.09 | 3.46% |
| 512px | convention-adjusted | 254 | 0.39 | 0.44% |

The two engines use different pixel-center conventions — the wasm engine maps
destination pixel centers (x+0.5, y+0.5) through the inverse homography and
subtracts 0.5 from the sampled source position, while the TS engines map raw
integer coordinates — so the raw diff mostly measures that half-pixel
convention shift; re-running the TS warp with the engine's convention drops
mean error ~2-3x and the >2 share ~4-8x, and 100% of the surviving >8 diffs
sit on partial-alpha quad-edge pixels where wasm interpolates premultiplied
alpha and TS interpolates straight alpha. Full numbers (including ±0.5 probe
offsets and the residual localization) in `results/js-wasm.json` under
`parity.wasmVsTsOptimized`.

Also in the full results: Group C (wasm `render_final`: ultra bicubic +
adaptive supersampling + PNG encode, no TS counterpart — 47.7 / 177.3 /
671.3 ms at 1024/2048/4096) and Group D (identity short-circuit detection:
~0.002 ms; production then reuses the original encoded bytes bit-exact).

## Machine & methodology

- Apple M4 Max (14 cores), macOS, Node v24.14.0. Requires Node 24+; TypeScript 6, vitest 4.
- **Canonical numbers are a 7-run variance study**: 7 full sequential
  `npm run bench` runs, ~10 s pause between runs, no other heavy load; each
  per-run value is already a median, and the canonical value is the **median
  of the 7 run-medians** with spread = min..max of the run medians
  (`results/runs/run-*.json`, aggregated by `scripts/aggregate.mjs` into
  `results/canonical.json`).
- Each case within a run: 2 untimed warmup iterations, then 5-20 timed
  iterations (10 for sizes ≤1024 in Group A and all of Group B, 5 for
  2048/4096 and Group C, 20 for Group D); per-run min/max/mean in the JSON.
- Run-to-run spread is engine-dependent (half-spread of run medians vs the
  canonical median): wasm ≤1.3% in Group A and ≤1.2% in Group B; ts-optimized
  11.5–17.5% across both groups. Single runs of this benchmark can therefore
  move the TS columns by double-digit percent — compare against the spreads,
  not the bare medians.
- Timings include the JS↔WASM boundary copies — production pays them too.
- The shipped WASM binary is built with `-C target-feature=+simd128`. SIMD128
  has been baseline in Chromium since Chrome 91 (Figma's plugin iframe) and is
  supported by Node ≥16, but the binary will not run on engines without WASM
  SIMD support — there is no scalar fallback build shipped (and per the probe
  above, simd128 is not where the speed comes from on this kernel).
- WASM instantiation (`initSync`) on this machine: 0.77 ms median
  (0.73–1.10 across the 7 runs) for the 572,837-byte module.

## License

Everything in this repository **except** `engine/transformer_engine_bg.wasm`
is MIT-licensed.

`engine/transformer_engine_bg.wasm` is the compiled, **proprietary** engine of
the "3D Image Transformer" Figma plugin, (c) 2026 Bohdan Serefaniuk. It is
included solely so the published benchmark numbers can be independently
re-run; no reverse engineering, no redistribution outside this repository, no
reuse. See [LICENSE](./LICENSE) for the exact terms.
