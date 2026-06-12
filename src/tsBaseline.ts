/**
 * tsBaseline.ts
 *
 * Pure TypeScript implementation of the same camera-based 3D perspective
 * transform as the Rust/WASM engine. This is used exclusively for benchmark
 * comparison (correctness reference + performance baseline).
 *
 * Pipeline:
 *   1. Build rotation matrix  R = Rz(roll) * Rx(pitch) * Ry(yaw)
 *   2. Project source quad corners through camera model (perspective divide)
 *   3. Map projected quad to destination pixel space (contain / crop)
 *   4. Compute 3x3 homography via 4-point DLT
 *   5. Invert homography for inverse mapping
 *   6. For each destination pixel, sample the source via bilinear interpolation
 *
 * Self-contained -- no imports from the engine package.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface TransformParams {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  fovDeg: number;
  distance: number;
  fitMode: 'contain' | 'crop';
}

// ── Small Linear-Algebra Helpers ───────────────────────────────────

/** Row-major 4x4 matrix stored as a flat Float64Array(16). */
type Mat4 = Float64Array;

/** Row-major 3x3 matrix stored as a flat Float64Array(9). */
type Mat3 = Float64Array;

function mat4RotationY(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  // prettier-ignore
  return new Float64Array([
     c,  0, s, 0,
     0,  1, 0, 0,
    -s,  0, c, 0,
     0,  0, 0, 1,
  ]);
}

function mat4RotationX(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  // prettier-ignore
  return new Float64Array([
    1,  0,  0, 0,
    0,  c, -s, 0,
    0,  s,  c, 0,
    0,  0,  0, 1,
  ]);
}

function mat4RotationZ(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  // prettier-ignore
  return new Float64Array([
     c, -s, 0, 0,
     s,  c, 0, 0,
     0,  0, 1, 0,
     0,  0, 0, 1,
  ]);
}

function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[r * 4 + k] * b[k * 4 + c];
      }
      out[r * 4 + c] = sum;
    }
  }
  return out;
}

function mat4TransformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  const rx = m[0] * x + m[1] * y + m[2] * z + m[3];
  const ry = m[4] * x + m[5] * y + m[6] * z + m[7];
  const rz = m[8] * x + m[9] * y + m[10] * z + m[11];
  return [rx, ry, rz];
}

// ── Mat3 helpers ───────────────────────────────────────────────────

function mat3Determinant(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

function mat3Inverse(m: Mat3): Mat3 | null {
  const det = mat3Determinant(m);
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1.0 / det;
  return new Float64Array([
    (m[4] * m[8] - m[5] * m[7]) * invDet,
    (m[2] * m[7] - m[1] * m[8]) * invDet,
    (m[1] * m[5] - m[2] * m[4]) * invDet,
    (m[5] * m[6] - m[3] * m[8]) * invDet,
    (m[0] * m[8] - m[2] * m[6]) * invDet,
    (m[2] * m[3] - m[0] * m[5]) * invDet,
    (m[3] * m[7] - m[4] * m[6]) * invDet,
    (m[1] * m[6] - m[0] * m[7]) * invDet,
    (m[0] * m[4] - m[1] * m[3]) * invDet,
  ]);
}

/** Apply 3x3 homography to a 2D point with perspective divide. */
function mat3TransformPoint(h: Mat3, x: number, y: number): [number, number] {
  const w = h[6] * x + h[7] * y + h[8];
  if (Math.abs(w) < 1e-12) return [NaN, NaN];
  return [
    (h[0] * x + h[1] * y + h[2]) / w,
    (h[3] * x + h[4] * y + h[5]) / w,
  ];
}

// ── Projection Pipeline ────────────────────────────────────────────

/** Build combined rotation: R = Rz(roll) * Rx(pitch) * Ry(yaw). */
function buildRotation(yawDeg: number, pitchDeg: number, rollDeg: number): Mat4 {
  const yawRad = (yawDeg * Math.PI) / 180;
  const pitchRad = (pitchDeg * Math.PI) / 180;
  const rollRad = (rollDeg * Math.PI) / 180;

  const ry = mat4RotationY(yawRad);
  const rx = mat4RotationX(pitchRad);
  const rz = mat4RotationZ(rollRad);

  // R = Rz * Rx * Ry  (applied right-to-left: yaw first, pitch second, roll last)
  return mat4Mul(rz, mat4Mul(rx, ry));
}

/**
 * Project the four source-image corners through the camera model.
 *
 * Source plane corners sit at (+-w/2, +-h/2, 0) in local space.
 * Camera looks along +Z at distance `d` (z-translation).
 * Perspective: f = 1 / tan(fov/2).
 *
 * Returns four 2D points: [TL, TR, BR, BL] in normalised camera space.
 */
function projectSourceCorners(
  params: TransformParams,
  srcW: number,
  srcH: number,
): [number, number][] {
  const halfW = srcW / 2;
  const halfH = srcH / 2;

  const fovDeg = Math.min(120, Math.max(10, params.fovDeg));
  const distance = Math.min(4, Math.max(0.3, params.distance));
  const fovRad = (fovDeg * Math.PI) / 180;
  const focal = 1 / Math.tan(fovRad / 2);
  const camDist = distance * srcH;

  const rotation = buildRotation(params.yawDeg, params.pitchDeg, params.rollDeg);

  // TL, TR, BR, BL in local space
  const localCorners: [number, number, number][] = [
    [-halfW, -halfH, 0],
    [halfW, -halfH, 0],
    [halfW, halfH, 0],
    [-halfW, halfH, 0],
  ];

  const projected: [number, number][] = [];

  for (let i = 0; i < 4; i++) {
    const [lx, ly, lz] = localCorners[i];
    const [rx, ry, rz] = mat4TransformPoint(rotation, lx, ly, lz);

    const tz = rz + camDist;

    if (tz < 1.0) {
      throw new Error(`Corner ${i} projects behind camera (z=${tz})`);
    }

    projected.push([focal * rx / tz, focal * ry / tz]);
  }

  return projected;
}

/**
 * Map projected quad coordinates into destination pixel coordinates.
 * contain: scale so the entire quad fits inside the frame.
 * crop: scale so the quad fills the frame (may clip corners).
 */
function quadToDstPixels(
  corners: [number, number][],
  dstW: number,
  dstH: number,
  fitMode: 'contain' | 'crop',
): [number, number][] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

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

  return corners.map(([px, py]) => [
    (px - quadCx) * scale + cx,
    (py - quadCy) * scale + cy,
  ]);
}

// ── 4-Point DLT Homography ─────────────────────────────────────────

/**
 * Compute 3x3 homography mapping `src` corners to `dst` corners
 * using Direct Linear Transform (DLT) on exactly 4 correspondences.
 *
 * Builds 8x9 system, solves via Gaussian elimination with partial pivoting.
 */
function computeHomography(
  src: [number, number][],
  dst: [number, number][],
): Mat3 {
  // Build 8x9 matrix A
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = src[i];
    const [dx, dy] = dst[i];
    a.push([-sx, -sy, -1, 0, 0, 0, sx * dx, sy * dx, dx]);
    a.push([0, 0, 0, -sx, -sy, -1, sx * dy, sy * dy, dy]);
  }

  // Forward elimination with partial pivoting
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
    if (maxVal < 1e-12) {
      throw new Error('Degenerate point configuration for homography');
    }
    if (maxRow !== col) {
      const tmp = a[col];
      a[col] = a[maxRow];
      a[maxRow] = tmp;
    }
    const pivot = a[col][col];
    for (let row = col + 1; row < 8; row++) {
      const factor = a[row][col] / pivot;
      for (let c = col; c < 9; c++) {
        a[row][c] -= factor * a[col][c];
      }
    }
  }

  // Back substitution: solve for h[0..8] with h[8] = 1
  const h = new Float64Array(9);
  h[8] = 1.0;
  for (let row = 7; row >= 0; row--) {
    let sum = 0;
    for (let c = row + 1; c < 9; c++) {
      sum += a[row][c] * h[c];
    }
    if (Math.abs(a[row][row]) < 1e-12) {
      throw new Error('Singular matrix in homography solve');
    }
    h[row] = -sum / a[row][row];
  }

  // Normalise so h[8] = 1
  const scale = h[8];
  if (Math.abs(scale) < 1e-12) {
    throw new Error('Degenerate homography (h[8] near zero)');
  }
  for (let i = 0; i < 9; i++) h[i] /= scale;

  return h;
}

/**
 * Compute the warp homography (and its inverse) that maps
 * source-image pixel coordinates to destination pixel coordinates.
 */
function computeWarpHomography(
  srcW: number,
  srcH: number,
  dstCorners: [number, number][],
): { h: Mat3; hInv: Mat3 } {
  const srcCorners: [number, number][] = [
    [0, 0],
    [srcW, 0],
    [srcW, srcH],
    [0, srcH],
  ];

  const h = computeHomography(srcCorners, dstCorners);
  const hInv = mat3Inverse(h);
  if (!hInv) {
    throw new Error('Homography matrix is singular');
  }
  return { h, hInv };
}

// ── Bilinear Sampling ──────────────────────────────────────────────

/**
 * Sample RGBA from source buffer at fractional (x, y) using bilinear
 * interpolation. Out-of-bounds pixels are treated as transparent black.
 *
 */
function sampleBilinear(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const fx = x - x0;
  const fy = y - y0;

  const fetch = (ix: number, iy: number): [number, number, number, number] => {
    if (ix < 0 || iy < 0 || ix >= srcW || iy >= srcH) return [0, 0, 0, 0];
    const idx = (iy * srcW + ix) * 4;
    return [src[idx], src[idx + 1], src[idx + 2], src[idx + 3]];
  };

  const p00 = fetch(x0, y0);
  const p10 = fetch(x1, y0);
  const p01 = fetch(x0, y1);
  const p11 = fetch(x1, y1);

  const r: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const top = p00[c] + (p10[c] - p00[c]) * fx;
    const bot = p01[c] + (p11[c] - p01[c]) * fx;
    const val = top + (bot - top) * fy;
    r[c] = Math.max(0, Math.min(255, Math.round(val)));
  }
  return r;
}

// ── Main Render Function ───────────────────────────────────────────

/**
 * Pure TypeScript reference renderer.
 *
 * @param srcRgba  - RGBA pixel data (ArrayBuffer, length = srcWidth * srcHeight * 4)
 * @param srcWidth - source width in pixels
 * @param srcHeight- source height in pixels
 * @param params   - camera transform parameters
 * @param maxSide  - maximum output dimension (same scaling logic as WASM preview)
 *
 * @returns { rgba, width, height, renderMs }
 */
export function tsBaselineRender(
  srcRgba: ArrayBuffer,
  srcWidth: number,
  srcHeight: number,
  params: TransformParams,
  maxSide: number,
): { rgba: ArrayBuffer; width: number; height: number; renderMs: number } {
  const t0 = performance.now();

  const srcData = new Uint8Array(srcRgba);

  // ── 1. Compute preview dimensions (scale down to maxSide, never upscale) ──
  const scale = Math.min(1, srcWidth >= srcHeight ? maxSide / srcWidth : maxSide / srcHeight);
  const outW = Math.max(1, Math.round(srcWidth * scale));
  const outH = Math.max(1, Math.round(srcHeight * scale));

  // ── 2. Project source corners through camera ──
  const projectedCorners = projectSourceCorners(params, srcWidth, srcHeight);

  // ── 3. Map projected quad to destination pixel space ──
  const dstCorners = quadToDstPixels(projectedCorners, outW, outH, params.fitMode);

  // ── 4. Compute homography inverse (dest -> source) ──
  const { hInv } = computeWarpHomography(srcWidth, srcHeight, dstCorners);

  // ── 5. Render via inverse mapping + bilinear sampling ──
  const outBuf = new Uint8Array(outW * outH * 4);

  for (let dy = 0; dy < outH; dy++) {
    for (let dx = 0; dx < outW; dx++) {
      const [sx, sy] = mat3TransformPoint(hInv, dx, dy);

      if (isNaN(sx) || isNaN(sy)) continue; // leave transparent

      const [r, g, b, a] = sampleBilinear(srcData, srcWidth, srcHeight, sx, sy);
      const outIdx = (dy * outW + dx) * 4;
      outBuf[outIdx] = r;
      outBuf[outIdx + 1] = g;
      outBuf[outIdx + 2] = b;
      outBuf[outIdx + 3] = a;
    }
  }

  const renderMs = performance.now() - t0;

  return {
    rgba: outBuf.buffer as ArrayBuffer,
    width: outW,
    height: outH,
    renderMs,
  };
}
