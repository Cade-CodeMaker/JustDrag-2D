/**
 * isnet-anime matting, ported from rembg to the browser.
 *
 * This is a line-for-line equivalent of rembg 2.0.73's `DisSession.predict` +
 * `naive_cutout`, because the already-shipped cutouts were produced by that code.
 * A silent divergence here would change delivered demos, so the odd-looking bits
 * below are deliberate and each one is called out:
 *
 *   1. `normalize()` rescales by the image's OWN max pixel value, not by 255.
 *      rembg does `im_ary / max(np.max(im_ary), 1e-6)`. For a typical image with
 *      a white background that equals /255, which is exactly why it is easy to
 *      "simplify" to /255 by accident and be right most of the time.
 *   2. std is (1,1,1) for this session, NOT ImageNet's (0.229,0.224,0.225).
 *      `U2netSession` passes the ImageNet std; `DisSession` does not. Using the
 *      wrong one still produces a plausible-looking mask, just a different one.
 *   3. `DisSession` writes `(pred * 255).astype("uint8")` with no clip.
 *      `U2netSession` clips. numpy's astype truncates toward zero, not rounds.
 *
 * The Python side of this same math is `core/matting.py`; `app/test/` is what
 * keeps the two honest, in the same spirit as `verify/` for the weight field.
 */

/** rembg resizes to the model's fixed input; isnet-anime is 1024x1024. */
export const SIZE = 1024;

/** ImageNet channel means, as passed by `DisSession`. */
const MEAN = [0.485, 0.456, 0.406];

/** `DisSession` passes (1,1,1) -- see the header note. */
const STD = [1.0, 1.0, 1.0];

/** px of colour dilation into the transparent margin. Mirrors `core.matting.BLEED`. */
export const BLEED = 8;

/** 8-neighbourhood, in the same order as `core.matting._NEIGHBOURS`. */
const NEIGHBOURS = [
  [0, 1], [0, -1], [1, 0], [-1, 0],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Create the inference session.
 *
 * `webgpu` is worth several times the wasm path on this model, but it is not
 * universally available, so the caller decides and we fail loudly rather than
 * silently falling back to a backend 5x slower without saying so.
 */
export async function createSession(modelUrl, { providers = ['webgpu'], onProgress } = {}) {
  const ort = await import('onnxruntime-web/webgpu');

  // Without this ORT asks for its .wasm next to the bundled script URL, Vite's
  // SPA fallback answers with index.html, and the failure reads as
  // "expected magic word 00 61 73 6d, found 3c 21 64 6f" (`<!do`).
  // scripts/sync-ort.mjs keeps this directory in sync with the installed version.
  ort.env.wasm.wasmPaths = '/ort/';

  if (onProgress) await fetchModel(modelUrl, onProgress);

  const session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: providers,
    graphOptimizationLevel: 'all',
  });
  return { ort, session };
}

/**
 * Warm the HTTP cache with a progress-reporting stream.
 *
 * The model is ~168MB, so a first-time user staring at a frozen button is a real
 * failure mode. `fetch` with a reader gives us byte counts; the same URL then
 * resolves from cache when ORT asks for it.
 */
async function fetchModel(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model fetch failed: ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return;

  const reader = res.body.getReader();
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.length;
    onProgress(seen, total);
  }
}

/**
 * Image -> NCHW float tensor, reproducing rembg's `BaseSession.normalize`.
 *
 * Note this resizes with the browser's own filter, which is not PIL's LANCZOS.
 * The mask therefore differs from Python's in the last fraction of a percent
 * along hard edges -- inherent to running in a canvas, and consistent with the
 * existing stance that cutout products are not bit-reproducible.
 */
export function toTensor(source) {
  const canvas = makeCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, SIZE, SIZE);
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);

  // rembg divides by the max over the whole RGB array, not by 255.
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > max) max = data[i];
    if (data[i + 1] > max) max = data[i + 1];
    if (data[i + 2] > max) max = data[i + 2];
  }
  const denom = Math.max(max, 1e-6);

  const plane = SIZE * SIZE;
  const out = new Float32Array(3 * plane);
  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    out[p] = (data[i] / denom - MEAN[0]) / STD[0];
    out[p + plane] = (data[i + 1] / denom - MEAN[1]) / STD[1];
    out[p + 2 * plane] = (data[i + 2] / denom - MEAN[2]) / STD[2];
  }
  return out;
}

/**
 * Raw model output -> an 8-bit mask at `outW`x`outH`.
 *
 * min-max rescale, x255, truncate, then LANCZOS-equivalent resize back up to the
 * original image size. The resize is what makes the mask usable on the original
 * pixels -- the model only ever saw 1024x1024.
 */
export function maskAtSize(pred, outW, outH) {
  let mi = Infinity;
  let ma = -Infinity;
  for (let i = 0; i < pred.length; i++) {
    const v = pred[i];
    if (v < mi) mi = v;
    if (v > ma) ma = v;
  }
  const span = ma - mi;

  const small = makeCanvas(SIZE, SIZE);
  const sctx = small.getContext('2d', { willReadFrequently: true });
  const img = sctx.createImageData(SIZE, SIZE);
  // One mask sample drives R, G and B equally; only L matters downstream.
  for (let p = 0, i = 0; p < SIZE * SIZE; p++, i += 4) {
    // numpy's astype(uint8) truncates toward zero -- so does | 0 for the [0,255] range.
    const v = ((pred[p] - mi) / span) * 255;
    const u = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    img.data[i] = u;
    img.data[i + 1] = u;
    img.data[i + 2] = u;
    img.data[i + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);

  const out = makeCanvas(outW, outH);
  const octx = out.getContext('2d', { willReadFrequently: true });
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(small, 0, 0, outW, outH);
  const { data } = octx.getImageData(0, 0, outW, outH);

  const mask = new Uint8Array(outW * outH);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) mask[p] = data[i];
  return mask;
}

/** Run one forward pass. Returns the raw (1,1,1024,1024) output as a flat array. */
export async function predict(ort, session, tensor) {
  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, SIZE, SIZE]) };
  const results = await session.run(feeds);
  return results[session.outputNames[0]].data;
}

/**
 * Push interior colour outward into the transparent margin.
 *
 * Without this the shader tears black notches along the contour: deforming
 * rotates the source, so the inverse map samples *outside* the silhouette, where
 * pixels are transparent and their RGB is garbage.
 *
 * Faithful to `core.matting.bleed`, including its use of `np.roll` -- which
 * WRAPS at the edges rather than clamping. Reproduced rather than corrected:
 * the shipped cutouts carry that behaviour, and they are what the demos were
 * built from.
 */
export function bleed(rgb, alpha, w, h, px = BLEED) {
  const n = w * h;

  let cur = Float32Array.from(rgb);          // mutates as it grows
  let known = new Uint8Array(n);
  for (let i = 0; i < n; i++) known[i] = alpha[i] > 0 ? 1 : 0;

  for (let step = 0; step < px; step++) {
    let allKnown = true;
    for (let i = 0; i < n; i++) if (!known[i]) { allKnown = false; break; }
    if (allKnown) break;

    const acc = new Float64Array(n * 3);
    const cnt = new Float64Array(n);
    for (const [dy, dx] of NEIGHBOURS) {
      for (let y = 0; y < h; y++) {
        // np.roll semantics: index wraps.
        const sy = (y + dy + h) % h;
        for (let x = 0; x < w; x++) {
          const sx = (x + dx + w) % w;
          const s = sy * w + sx;
          if (!known[s]) continue;
          const d = y * w + x;
          acc[d * 3] += cur[s * 3];
          acc[d * 3 + 1] += cur[s * 3 + 1];
          acc[d * 3 + 2] += cur[s * 3 + 2];
          cnt[d] += 1;
        }
      }
    }

    const grown = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      if (!known[i] && cnt[i] > 0) {
        cur[i * 3] = acc[i * 3] / cnt[i];
        cur[i * 3 + 1] = acc[i * 3 + 1] / cnt[i];
        cur[i * 3 + 2] = acc[i * 3 + 2] / cnt[i];
        grown[i] = 1;
        any = true;
      }
    }
    if (!any) break;
    for (let i = 0; i < n; i++) if (grown[i]) known[i] = 1;
  }
  return cur;
}

/**
 * Full cutout: image -> { rgb, alpha } at the source's own resolution.
 *
 * `alpha` is the ORIGINAL mask, never the widened one -- the mask grown inside
 * `bleed` exists only to track how far colour has spread, and leaking it into
 * the result would silently erase the character's soft edge.
 */
export async function cutout(ort, session, source, { width, height }, { onStage } = {}) {
  const say = onStage || (() => {});
  const marks = [];
  let last = performance.now();
  // Called AFTER a stage finishes, under that stage's own name. The alternative
  // -- announcing each stage then timing entry-to-entry -- lags every label by
  // one and hides the final stage's cost entirely.
  const mark = name => {
    const now = performance.now();
    marks.push({ stage: name, ms: now - last });
    last = now;
  };

  say('preprocess');
  const tensor = toTensor(source);
  mark('preprocess');

  say('infer');
  const pred = await predict(ort, session, tensor);
  mark('infer');

  say('resize mask');
  const alpha = maskAtSize(pred, width, height);
  mark('resize mask');

  say('sample colour');
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  const rgb = new Float32Array(width * height * 3);
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    rgb[p * 3] = data[i];
    rgb[p * 3 + 1] = data[i + 1];
    rgb[p * 3 + 2] = data[i + 2];
  }

  mark('sample colour');

  say('edge bleed');
  const bled = bleed(rgb, alpha, width, height);
  mark('edge bleed');

  return { rgb: bled, alpha, width, height, marks };
}
