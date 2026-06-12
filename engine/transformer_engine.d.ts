/* tslint:disable */
/* eslint-disable */

/**
 * Create a rendering session from encoded image bytes (PNG/JPEG/GIF).
 * Returns a session ID for subsequent render calls.
 */
export function create_session(source_bytes: Uint8Array): number;

/**
 * Destroy a session and free memory.
 */
export function destroy_session(session_id: number): void;

/**
 * Hello-path verification: confirms WASM loads and runs correctly.
 */
export function greet(name: string): string;

/**
 * True when the transform reproduces the source exactly (within epsilon) at
 * identical output dimensions. The caller should then skip rendering AND
 * re-encoding entirely and reuse the original encoded bytes — the only way
 * to make a no-op transform bit-identical.
 */
export function is_identity_transform(session_id: number, params_json: string): boolean;

/**
 * Render the final corner-pin mockup at full background resolution,
 * encoded as PNG or JPEG.
 *
 * Returns [u32_le width, u32_le height, ...encoded...].
 */
export function render_corner_pin_final(design_session_id: number, background_session_id: number, pin_json: string, output_format: string, jpeg_quality: number): Uint8Array;

/**
 * Render a corner-pin mockup preview: the design warped onto the
 * 4-corner quad over the background, downscaled to max_side.
 *
 * The background's anti-aliased downscale is built once and cached on its
 * session (preview base) — interactive corner drags then only pay for the
 * design warp + composite, not a full background resample per frame.
 *
 * Returns [u32_le width, u32_le height, ...rgba...].
 */
export function render_corner_pin_preview(design_session_id: number, background_session_id: number, pin_json: string, max_side: number): Uint8Array;

/**
 * Render the final Ultra output as encoded image bytes (PNG or JPEG).
 *
 * Returns a byte buffer prefixed with an 8-byte header:
 *   [u32_le width, u32_le height, ...encoded_bytes...]
 */
export function render_final(session_id: number, params_json: string, output_format: string, jpeg_quality: number): Uint8Array;

/**
 * Render a preview frame.
 *
 * Returns a byte buffer prefixed with an 8-byte header:
 *   [u32_le width, u32_le height, ...rgba_data...]
 *
 * Preview is scaled down so max(width, height) <= max_side. The first call
 * builds a high-quality downscaled preview base which later calls reuse, so
 * interactive frames warp a small, properly prefiltered image instead of
 * point-sampling the full-resolution source (faster AND less aliased).
 * `quality` is "draft" (bilinear, drag-time) or "ultra" (refined idle frame).
 */
export function render_preview(session_id: number, params_json: string, max_side: number, quality: string): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly create_session: (a: number, b: number, c: number) => void;
    readonly greet: (a: number, b: number, c: number) => void;
    readonly is_identity_transform: (a: number, b: number, c: number, d: number) => void;
    readonly render_corner_pin_final: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly render_corner_pin_preview: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly render_final: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly render_preview: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly destroy_session: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
