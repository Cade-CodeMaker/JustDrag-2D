/**
 * GIF encoding: palette, dithering, frame writing.
 *
 * Pure -- no WebGL, no DOM. The GL half that produces the frames lives in
 * stage.js, so this module can be exercised in Node against synthetic frames.
 *
 * gifenc does the LZW and the colour quantisation. It has no dithering, which
 * is why Floyd-Steinberg is hand-rolled below: measured on a real frame, the
 * quantisation error lands almost entirely on the character's gradients
 * (~11% of character pixels off by more than 8/255), while the flat background
 * is nearly free. Dithering is the only lever against that.
 *
 * The import is a deep path on purpose. The package has no `exports` map, so
 * Node resolves `main` to the CJS build -- whose named exports the CJS lexer
 * cannot see, making `import { GIFEncoder } from 'gifenc'` a SyntaxError. This
 * path is the same file Vite picks via the `module` field, so both environments
 * run identical code rather than merely equivalent code.
 */
import { GIFEncoder, quantize, applyPalette, nearestColorIndex } from 'gifenc/dist/gifenc.esm.js';

/**
 * gifenc's own rgb565 key, copied deliberately: our nearest-colour lookup must
 * bucket colours the same way its applyPalette does, or the dithered and
 * undithered paths would disagree about which colour is nearest.
 *
 * (Green really does only get 5 bits here -- that is what the library does, and
 * matching it matters more than being right about it.)
 */
const key565 = (r, g, b) => (((r & 0xF8) << 8) | ((g & 0xF8) << 2) | (b >> 3)) & 0xFFFF;

const clamp8 = v => (v < 0 ? 0 : v > 255 ? 255 : v);
const clampErr = v => (v < -48 ? -48 : v > 48 ? 48 : v);

/**
 * A nearest-palette-entry table keyed by rgb565 -- 65536 entries, built once.
 *
 * Without this, dithering a 50-frame 512px export means 13M pixels x 256
 * palette entries of distance maths. With it, one array lookup per pixel. It is
 * the difference between a couple of seconds and a frozen tab.
 */
export function buildNearestLut(palette) {
  const lut = new Uint8Array(65536);
  for (let k = 0; k < 65536; k++) {
    // Reconstruct the midpoint of the cell this key represents, so the lookup
    // is nearest-to-the-cell rather than nearest-to-its-corner.
    const r = (((k >> 11) & 31) << 3) | 4;
    const g = (((k >> 5) & 31) << 3) | 4;
    const b = ((k & 31) << 3) | 4;
    lut[k] = nearestColorIndex(palette, [r, g, b]);
  }
  return lut;
}

/**
 * Floyd-Steinberg against a fixed palette, returning palette indices.
 *
 * Serpentine: the error kernel is mirrored on alternate rows. Raster-order FS
 * on a smooth gradient leaves diagonal streaks -- the error always travels the
 * same way -- and mirroring is what removes them.
 *
 * Alpha is ignored: the capture step guarantees every pixel is opaque before it
 * gets here (in-square from the shader, out-of-square from the background fill).
 */
export function ditherToIndices(rgba, width, height, palette, lut) {
  const idx = new Uint8Array(width * height);
  let cur = new Float32Array(width * 3);   // error inherited by this row
  let nxt = new Float32Array(width * 3);   // error handed to the next row

  const spread = (buf, x, er, eg, eb) => {
    if (x < 0 || x >= width) return;
    const o = x * 3;
    buf[o] += er; buf[o + 1] += eg; buf[o + 2] += eb;
  };

  for (let y = 0; y < height; y++) {
    const ltr = (y & 1) === 0;
    const stepX = ltr ? 1 : -1;
    const startX = ltr ? 0 : width - 1;
    nxt.fill(0);

    for (let i = 0; i < width; i++) {
      const x = startX + i * stepX;
      const p = (y * width + x) << 2;
      const r = clamp8(rgba[p] + cur[x * 3]);
      const g = clamp8(rgba[p + 1] + cur[x * 3 + 1]);
      const b = clamp8(rgba[p + 2] + cur[x * 3 + 2]);

      const ci = lut[key565(r, g, b)];
      idx[y * width + x] = ci;

      // Error against the colour actually chosen, clamped so saturated areas
      // cannot accumulate runaway error into visible blotches.
      const pc = palette[ci];
      const er = clampErr(r - pc[0]);
      const eg = clampErr(g - pc[1]);
      const eb = clampErr(b - pc[2]);

      spread(cur, x + stepX, er * 7 / 16, eg * 7 / 16, eb * 7 / 16);   // ahead, same row
      spread(nxt, x - stepX, er * 3 / 16, eg * 3 / 16, eb * 3 / 16);   // behind, next row
      spread(nxt, x, er * 5 / 16, eg * 5 / 16, eb * 5 / 16);           // below
      spread(nxt, x + stepX, er * 1 / 16, eg * 1 / 16, eb * 1 / 16);   // ahead, next row
    }
    const t = cur; cur = nxt; nxt = t;
  }
  return idx;
}

/**
 * One palette for the whole animation.
 *
 * Sampled from frames spread across the cycle rather than from frame 0: some
 * colours only appear at one extreme of the swing, and a palette built from the
 * first frame would band on them for the entire loop.
 *
 * The background colour is forced in. It is one flat colour covering a large
 * share of the frame, and a median-cut quantiser can still spend its slot on
 * the character's gradients -- which would make the one region that is supposed
 * to be free the one that bands.
 *
 * NOTE: quantize() reads `new Uint32Array(data.buffer)`, i.e. the whole
 * underlying buffer, ignoring any byteOffset. Always hand it a freshly
 * allocated contiguous array -- never a subarray.
 */
export function samplePalette(frames, bgRgb, maxColors = 256, budget = 150000) {
  const total = frames.reduce((n, f) => n + (f.length >> 2), 0);
  const stride = Math.max(1, Math.floor(total / budget));
  const keep = Math.ceil(total / stride);
  const out = new Uint8Array(keep * 4);

  let src = 0, dst = 0, seen = 0;
  for (const f of frames) {
    const px = f.length >> 2;
    for (let i = 0; i < px; i++) {
      if (seen++ % stride === 0 && dst + 3 < out.length) {
        out[dst] = f[i * 4]; out[dst + 1] = f[i * 4 + 1];
        out[dst + 2] = f[i * 4 + 2]; out[dst + 3] = 255;
        dst += 4;
      }
    }
    src++;
  }

  const palette = quantize(out.subarray(0, dst), maxColors, { format: 'rgb565', clearAlpha: false });
  return forceColor(palette, bgRgb);
}

/**
 * Make sure `rgb` is in the palette, replacing the least useful entry.
 *
 * "Least useful" is approximated by the entry nearest to another entry -- it is
 * the one a merge would have removed anyway, so dropping it costs the least.
 */
function forceColor(palette, rgb) {
  if (!rgb) return palette;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = dist2(palette[i], rgb);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (bestD <= 4) return palette;   // already close enough

  let victim = -1, victimD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    let near = Infinity;
    for (let j = 0; j < palette.length; j++) {
      if (i === j) continue;
      const d = dist2(palette[i], palette[j]);
      if (d < near) near = d;
    }
    if (near < victimD) { victimD = near; victim = i; }
  }
  if (victim >= 0) palette[victim] = [rgb[0], rgb[1], rgb[2]];
  return palette;
}

const dist2 = (a, b) => {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
};

/**
 * Encode frames into a looping GIF89a.
 *
 * `frames` is an async iterable of top-down, opaque RGBA buffers, one per
 * frame -- streamed rather than collected, because holding all of them at
 * 1024px would be hundreds of megabytes.
 *
 * `delayMs` must be a whole number of centiseconds (delayCs * 10). gifenc
 * divides by 10 internally, so passing `1000 / fps` would round twice and
 * silently play at the wrong speed. Computed once in pose.js's framePlan.
 */
export async function encodeGif({ width, height, palette, frames, delayMs, dither, onProgress }) {
  const enc = GIFEncoder();
  const lut = dither ? buildNearestLut(palette) : null;

  let first = true;
  let k = 0;
  for await (const rgba of frames) {
    const index = dither ? ditherToIndices(rgba, width, height, palette, lut)
                         : applyPalette(rgba, palette);

    // The palette goes on the first frame only. gifenc writes a LOCAL colour
    // table whenever a palette is passed to a later frame -- about 768 wasted
    // bytes per frame, for a table identical to the global one.
    enc.writeFrame(index, width, height, first
      ? { palette, delay: delayMs, repeat: 0 }
      : { delay: delayMs });

    first = false;
    k++;
    if (onProgress) onProgress(k);
  }

  enc.finish();
  return enc.bytes();
}
