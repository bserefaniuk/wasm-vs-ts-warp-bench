/**
 * tsOptimized.ts
 *
 * Hand-optimized TypeScript variant of the bilinear inverse warp in
 * tsBaseline.ts. Exists ONLY for benchmark comparison (naive TS vs
 * optimized TS vs Rust/WASM). Same camera model, same output-dims
 * formula, same out-of-bounds-is-transparent semantics as tsBaseline.
 *
 * Optimizations vs tsBaseline:
 *   - homography applied inline in the pixel loop (no function calls)
 *   - zero per-pixel allocations (no tuples, no closures)
 *   - typed arrays in/out, flat scalar locals only
 */

import type { TransformParams } from './tsBaseline';

// ── Setup math (runs once per frame; allocations here are fine) ────

function mat4Mul(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = sum;
    }
  }
  return out;
}

/** R = Rz(roll) * Rx(pitch) * Ry(yaw) — identical op order to tsBaseline. */
function buildRotation(yawDeg: number, pitchDeg: number, rollDeg: number): Float64Array {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const roll = (rollDeg * Math.PI) / 180;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cx = Math.cos(pitch), sx = Math.sin(pitch);
  const cz = Math.cos(roll), sz = Math.sin(roll);
  // prettier-ignore
  const ry = new Float64Array([cy, 0, sy, 0, 0, 1, 0, 0, -sy, 0, cy, 0, 0, 0, 0, 1]);
  // prettier-ignore
  const rx = new Float64Array([1, 0, 0, 0, 0, cx, -sx, 0, 0, sx, cx, 0, 0, 0, 0, 1]);
  // prettier-ignore
  const rz = new Float64Array([cz, -sz, 0, 0, sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  return mat4Mul(rz, mat4Mul(rx, ry));
}

/** Project source corners through the camera; returns [TL,TR,BR,BL] (x,y). */
function projectSourceCorners(
  params: TransformParams,
  srcW: number,
  srcH: number,
): [number, number][] {
  const halfW = srcW / 2;
  const halfH = srcH / 2;
  const fovDeg = Math.min(120, Math.max(10, params.fovDeg));
  const distance = Math.min(4, Math.max(0.3, params.distance));
  const focal = 1 / Math.tan(((fovDeg * Math.PI) / 180) / 2);
  const camDist = distance * srcH;
  const m = buildRotation(params.yawDeg, params.pitchDeg, params.rollDeg);

  const local: [number, number, number][] = [
    [-halfW, -halfH, 0], [halfW, -halfH, 0], [halfW, halfH, 0], [-halfW, halfH, 0],
  ];
  const projected: [number, number][] = [];
  for (let i = 0; i < 4; i++) {
    const [lx, ly, lz] = local[i];
    const rx = m[0] * lx + m[1] * ly + m[2] * lz + m[3];
    const ry = m[4] * lx + m[5] * ly + m[6] * lz + m[7];
    const rz = m[8] * lx + m[9] * ly + m[10] * lz + m[11];
    const tz = rz + camDist;
    if (tz < 1.0) throw new Error(`Corner ${i} projects behind camera (z=${tz})`);
    projected.push([(focal * rx) / tz, (focal * ry) / tz]);
  }
  return projected;
}

/** Map projected quad into destination pixel coordinates (contain/crop). */
function quadToDstPixels(
  corners: [number, number][],
  dstW: number,
  dstH: number,
  fitMode: 'contain' | 'crop',
): [number, number][] {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [px, py] of corners) {
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }
  const quadW = maxX - minX;
  const quadH = maxY - minY;
  if (quadW < 1e-10 || quadH < 1e-10) {
    const cx = dstW / 2;
    const cy = dstH / 2;
    return [[cx, cy], [cx, cy], [cx, cy], [cx, cy]];
  }
  const scale =
    fitMode === 'contain'
      ? Math.min(dstW / quadW, dstH / quadH)
      : Math.max(dstW / quadW, dstH / quadH);
  const cx = dstW / 2;
  const cy = dstH / 2;
  const quadCx = (minX + maxX) / 2;
  const quadCy = (minY + maxY) / 2;
  return corners.map(([px, py]) => [(px - quadCx) * scale + cx, (py - quadCy) * scale + cy]);
}

/** 4-point DLT homography (Gaussian elimination, partial pivoting). */
function computeHomography(src: [number, number][], dst: [number, number][]): Float64Array {
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = src[i];
    const [dx, dy] = dst[i];
    a.push([-sx, -sy, -1, 0, 0, 0, sx * dx, sy * dx, dx]);
    a.push([0, 0, 0, -sx, -sy, -1, sx * dy, sy * dy, dy]);
  }
  for (let col = 0; col < 8; col++) {
    let maxVal = Math.abs(a[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < 8; row++) {
      const val = Math.abs(a[row][col]);
      if (val > maxVal) {
        maxVal = val;
        maxRow = row;
      }
    }
    if (maxVal < 1e-12) throw new Error('Degenerate point configuration for homography');
    if (maxRow !== col) {
      const tmp = a[col];
      a[col] = a[maxRow];
      a[maxRow] = tmp;
    }
    const pivot = a[col][col];
    for (let row = col + 1; row < 8; row++) {
      const factor = a[row][col] / pivot;
      for (let c = col; c < 9; c++) a[row][c] -= factor * a[col][c];
    }
  }
  const h = new Float64Array(9);
  h[8] = 1.0;
  for (let row = 7; row >= 0; row--) {
    let sum = 0;
    for (let c = row + 1; c < 9; c++) sum += a[row][c] * h[c];
    if (Math.abs(a[row][row]) < 1e-12) throw new Error('Singular matrix in homography solve');
    h[row] = -sum / a[row][row];
  }
  const scale = h[8];
  if (Math.abs(scale) < 1e-12) throw new Error('Degenerate homography (h[8] near zero)');
  for (let i = 0; i < 9; i++) h[i] /= scale;
  return h;
}

function mat3Inverse(m: Float64Array): Float64Array {
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (Math.abs(det) < 1e-12) throw new Error('Homography matrix is singular');
  const d = 1.0 / det;
  return new Float64Array([
    (m[4] * m[8] - m[5] * m[7]) * d, (m[2] * m[7] - m[1] * m[8]) * d, (m[1] * m[5] - m[2] * m[4]) * d,
    (m[5] * m[6] - m[3] * m[8]) * d, (m[0] * m[8] - m[2] * m[6]) * d, (m[2] * m[3] - m[0] * m[5]) * d,
    (m[3] * m[7] - m[4] * m[6]) * d, (m[1] * m[6] - m[0] * m[7]) * d, (m[0] * m[4] - m[1] * m[3]) * d,
  ]);
}

/**
 * Inverse warp homography (destination px -> source px) for the given camera
 * params and output size. Used internally by tsOptimizedRender and exported
 * for benchmark parity diagnostics (pixel-center convention probes).
 */
export function computeInverseWarp(
  srcWidth: number,
  srcHeight: number,
  params: TransformParams,
  outW: number,
  outH: number,
): Float64Array {
  const dstCorners = quadToDstPixels(
    projectSourceCorners(params, srcWidth, srcHeight),
    outW,
    outH,
    params.fitMode,
  );
  const srcCorners: [number, number][] = [[0, 0], [srcWidth, 0], [srcWidth, srcHeight], [0, srcHeight]];
  return mat3Inverse(computeHomography(srcCorners, dstCorners));
}

// ── Main render (hot path: flat, zero per-pixel allocations) ───────

export function tsOptimizedRender(
  srcRgba: ArrayBuffer,
  srcWidth: number,
  srcHeight: number,
  params: TransformParams,
  maxSide: number,
): { rgba: ArrayBuffer; width: number; height: number; renderMs: number } {
  const t0 = performance.now();
  const src = new Uint8Array(srcRgba);

  const scale = Math.min(1, srcWidth >= srcHeight ? maxSide / srcWidth : maxSide / srcHeight);
  const outW = Math.max(1, Math.round(srcWidth * scale));
  const outH = Math.max(1, Math.round(srcHeight * scale));

  const inv = computeInverseWarp(srcWidth, srcHeight, params, outW, outH);
  const h0 = inv[0], h1 = inv[1], h2 = inv[2];
  const h3 = inv[3], h4 = inv[4], h5 = inv[5];
  const h6 = inv[6], h7 = inv[7], h8 = inv[8];

  const out = new Uint8Array(outW * outH * 4);
  const stride = srcWidth * 4;
  let outIdx = 0;

  for (let dy = 0; dy < outH; dy++) {
    for (let dx = 0; dx < outW; dx++, outIdx += 4) {
      const w = h6 * dx + h7 * dy + h8;
      if (w < 1e-12 && w > -1e-12) continue; // matches baseline NaN skip
      const sx = (h0 * dx + h1 * dy + h2) / w;
      const sy = (h3 * dx + h4 * dy + h5) / w;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = x0 + 1;
      const y1 = y0 + 1;
      if (x1 < 0 || y1 < 0 || x0 >= srcWidth || y0 >= srcHeight) continue; // fully outside
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

  return { rgba: out.buffer as ArrayBuffer, width: outW, height: outH, renderMs: performance.now() - t0 };
}
