# WASM Module Size Breakdown — transformer_engine_bg.wasm

Shipped artifact: `engine/transformer_engine_bg.wasm (built from the plugin monorepo; sha256 b30c4e2cc19b11914533077c62963b6ddbe3136c979a5497fbeb1b2d98ff73c6)` — **572,837 bytes**
(release profile: `opt-level = 3`, `lto = true`, `codegen-units = 1`, `strip = true`,
`wasm-opt = false`, RUSTFLAGS `-C target-feature=+simd128`).

Tooling: `twiggy` 0.7.0 (installed via `cargo install twiggy`).

## Raw twiggy output (shipped wasm)

`twiggy top -n 25` on the shipped binary. Note: `strip = true` removes the
name section, so items show as anonymous `code[N]` / `data[N]`:

```text
 Shallow Bytes │ Shallow % │ Item
───────────────┼───────────┼────────────────────
         88898 ┊    15.52% ┊ data[0]
         14224 ┊     2.48% ┊ code[1]
         14040 ┊     2.45% ┊ code[3]
         13963 ┊     2.44% ┊ code[0]
         13594 ┊     2.37% ┊ code[2]
         11308 ┊     1.97% ┊ code[4]
         11058 ┊     1.93% ┊ code[5]
          9512 ┊     1.66% ┊ code[6]
          9135 ┊     1.59% ┊ code[7]
          8128 ┊     1.42% ┊ code[8]
          7824 ┊     1.37% ┊ code[9]
          6962 ┊     1.22% ┊ code[11]
          6788 ┊     1.18% ┊ code[10]
          6628 ┊     1.16% ┊ code[14]
          6506 ┊     1.14% ┊ code[13]
          6458 ┊     1.13% ┊ code[19]
          6096 ┊     1.06% ┊ code[12]
          5627 ┊     0.98% ┊ code[18]
          5613 ┊     0.98% ┊ code[15]
          5531 ┊     0.97% ┊ code[17]
          5116 ┊     0.89% ┊ code[16]
          4694 ┊     0.82% ┊ code[20]
          4044 ┊     0.71% ┊ code[21]
          3982 ┊     0.70% ┊ code[23]
          3848 ┊     0.67% ┊ code[22]
        293260 ┊    51.19% ┊ ... and 835 more.
        572837 ┊   100.00% ┊ Σ [860 Total Rows]
```

`twiggy dominators -d 3` (first 25 rows of 666; the dominator tree is rooted
at the indirect-call table, which retains 41.8% — everything reachable only
through `table[0]`/`elem[0]` indirect calls, dominated by one 106 KB function):

```text
 Retained Bytes │ Retained % │ Dominator Tree
────────────────┼────────────┼──────────────────────────────────────────────────────────────────────────────
         239689 ┊     41.84% ┊ table[0]
         239683 ┊     41.84% ┊   ⤷ elem[0]
         106139 ┊     18.53% ┊       ⤷ code[82]
          20154 ┊      3.52% ┊       ⤷ code[1]
          16880 ┊      2.95% ┊       ⤷ code[32]
           6096 ┊      1.06% ┊       ⤷ code[12]
           5116 ┊      0.89% ┊       ⤷ code[16]
           3031 ┊      0.53% ┊       ⤷ code[331]
           2853 ┊      0.50% ┊       ⤷ code[548]
           2815 ┊      0.49% ┊       ⤷ code[437]
           2541 ┊      0.44% ┊       ⤷ code[39]
           2396 ┊      0.42% ┊       ⤷ code[718]
           2101 ┊      0.37% ┊       ⤷ code[69]
           1913 ┊      0.33% ┊       ⤷ code[523]
           1793 ┊      0.31% ┊       ⤷ code[49]
           1782 ┊      0.31% ┊       ⤷ code[72]
           1702 ┊      0.30% ┊       ⤷ code[112]
           1685 ┊      0.29% ┊       ⤷ code[52]
           1542 ┊      0.27% ┊       ⤷ code[213]
           1518 ┊      0.26% ┊       ⤷ code[703]
           1330 ┊      0.23% ┊       ⤷ code[116]
           1276 ┊      0.22% ┊       ⤷ code[99]
           1200 ┊      0.21% ┊       ⤷ code[158]
```

## Symbol attribution (names-preserved side build)

Because the shipped wasm is stripped, attribution uses an identical side build
with symbol names kept — same crate, same profile and SIMD flags, only
`strip` disabled, built into a throwaway target dir (no repo artifacts touched):

```sh
CARGO_TARGET_DIR=/tmp/engine-twiggy-target cargo build --release \
  --target wasm32-unknown-unknown --config 'profile.release.strip=false'
```

This pre-wasm-bindgen artifact is 2,093,721 bytes, of which 1,486,511 bytes are
DWARF debug + name custom sections (absent from the shipped binary). Its
**function code totals 518,280 bytes** and its `.rodata` data segment is
88,930 bytes — the shipped binary's lone data segment is 88,898 bytes, so the
code/data composition maps over almost 1:1.

`twiggy top` head of the names build (debug sections lead, then real symbols):

```text
 Shallow Bytes │ Shallow % │ Item
───────────────┼───────────┼────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
        653766 ┊    31.23% ┊ custom section '.debug_str'
        396294 ┊    18.93% ┊ custom section '.debug_info'
        254800 ┊    12.17% ┊ custom section '.debug_line'
         96904 ┊     4.63% ┊ custom section '.debug_ranges'
         88898 ┊     4.25% ┊ data segment ".rodata"
         68258 ┊     3.26% ┊ "function names" subsection
         14850 ┊     0.71% ┊ zune_jpeg::decoder::JpegDecoder<T>::decode_headers_internal::h338d6a74ade24854
         14732 ┊     0.70% ┊ zune_jpeg::bitstream::BitStream::decode_mcu_ac_refine::h03da3df148a77154
         14666 ┊     0.70% ┊ zune_jpeg::decoder::JpegDecoder<T>::decode_headers_internal::h9c2bd448ffcf7c66
         14316 ┊     0.68% ┊ zune_jpeg::mcu_prog::<impl zune_jpeg::decoder::JpegDecoder<T>>::parse_entropy_coded_data::he491d01035f7da3c
         11701 ┊     0.56% ┊ fdeflate::decompress::Decompressor::read::hcbf7587185ad6201
         11522 ┊     0.55% ┊ zune_jpeg::decoder::JpegDecoder<T>::parse_marker_inner::h8fb9c42a27aa3594
          9985 ┊     0.48% ┊ transformer_engine::codec::decode::decode_image::h91261f80428f4284
          9587 ┊     0.46% ┊ zune_jpeg::mcu::<impl zune_jpeg::decoder::JpegDecoder<T>>::decode_mcu_ycbcr_baseline::h464f4ee9f3172fc9
          9072 ┊     0.43% ┊ custom section '__wasm_bindgen_unstable'
          8554 ┊     0.41% ┊ zune_jpeg::bitstream::BitStream::discard_mcu_block::heb84976ea4186b79
          8252 ┊     0.39% ┊ zune_jpeg::bitstream::BitStream::decode_mcu_block::hcea8dfd905b0c186
          7151 ┊     0.34% ┊ png::decoder::stream::StreamingDecoder::parse_u32::h73004df8c74f2b0b
          6995 ┊     0.33% ┊ custom section '.debug_abbrev'
          6897 ┊     0.33% ┊ miniz_oxide::deflate::core::compress_inner::h20e1ac4a466aa436
          6764 ┊     0.32% ┊ zune_jpeg::worker::color_convert::h50462a4c2a269d13
          6665 ┊     0.32% ┊ transformer_engine::codec::encode::encode_jpeg::h68b0e671ec35af0c
          6529 ┊     0.31% ┊ png::decoder::unfiltering_buffer::UnfilteringBuffer::unfilter_curr_row::h10e27e6f97305002
          6292 ┊     0.30% ┊ core::num::flt2dec::strategy::dragon::format_shortest::h50572f10f708cf3f
          6009 ┊     0.29% ┊ transformer_engine::codec::encode::encode_png::h9b4a6e8ec69e72e9
          5743 ┊     0.27% ┊ miniz_oxide::deflate::core::compress_block::hf3c48379bdbe562d
          5699 ┊     0.27% ┊ transformer_engine::render::tile::render_tiled::h17e31f81fb461ca7
          5285 ┊     0.25% ┊ core::num::flt2dec::strategy::dragon::format_exact::h470014d8ef3056f8
          5103 ┊     0.24% ┊ dlmalloc::dlmalloc::Dlmalloc<A>::malloc::h56d0ddc1cdd2a835
          4169 ┊     0.20% ┊ fdeflate::huffman::build_table::h423293f63c14dfaa
          4015 ┊     0.19% ┊ compiler_builtins::math::libm_math::rem_pio2_large::rem_pio2_large::hae1cdbe2633a1414
```

### Category totals (% of the 518,280 bytes of function code)

| Category | Bytes | % of code |
|---|---|---|
| (a) Image codecs (zune_jpeg + zune_core, png, image, fdeflate, miniz_oxide, crc32/adler, engine codec glue) | 350,626 | **67.7%** |
| (b) Core engine: math / render / sampling / session / exports | 26,817 | **5.2%** |
| (c) std/alloc/fmt, serde + serde_json, dlmalloc, wasm-bindgen glue, misc | 140,837 | **27.2%** |

Notable subcategories:

| Subcategory | Bytes | % of code |
|---|---|---|
| zune_jpeg + zune_core (JPEG decode) | 170,789 | 33.0% |
| png crate (PNG decode/encode) | 69,863 | 13.5% |
| std/core/alloc | 64,880 | 12.5% |
| image crate (codec plumbing) | 47,311 | 9.1% |
| misc other (mostly core::fmt impls, hashbrown, float formatting) | 38,465 | 7.4% |
| serde + serde_json (params parsing) | 29,530 | 5.7% |
| fdeflate (PNG inflate/deflate) | 21,897 | 4.2% |
| miniz_oxide (deflate) | 21,025 | 4.1% |
| transformer_engine::codec (decode/encode glue) | 16,650 | 3.2% |
| dlmalloc (allocator) | 7,750 | 1.5% |
| crc32fast + adler | 2,700 | 0.5% |
| transformer_engine math + render + sampling + session + exported API fns | 26,817 | 5.2% |

The shipped binary additionally carries the 88,898-byte data segment (15.5% of
the 572,837-byte file) — lookup tables and string constants, not split by
twiggy; the largest contributors are codec huffman/CRC tables and serde/codec
error strings.

## Verdict: "codecs are most of it"

**TRUE.** Roughly two thirds (67.7%) of all function code is PNG/JPEG codec
machinery — JPEG decoding alone (zune_jpeg/zune_core) is 33.0%. The actual 3D
transform engine — projection math, homography, tiled renderer, bilinear/
bicubic/supersampling, session management — is **5.2%** of function code
(~27 KB). The engine logic is a rounding error; the binary is mostly "be able
to read and write image files".

## Transform params payload size

`Buffer.byteLength(JSON.stringify({yawDeg:25,pitchDeg:-15,rollDeg:3,fovDeg:50,distance:1.5,fitMode:'contain'}))`
= **87 bytes** (Node v24.14.0).
