/**
 * The Python-parity checks, kept as a module of their own.
 *
 * These are the regression tests for the matting port, and they live in the app
 * rather than in a test harness because the comparison has to happen on the raw
 * float output -- shipping 4MB of results back through Runtime.evaluate as JSON
 * would be wasteful and slow. app/test/matting.test.js drives them over CDP.
 *
 * Only the test seam imports this, so none of it runs for a normal user.
 */
import * as M from './matting.js';

/**
 * Test A -- does onnxruntime-web compute what onnxruntime-python computes?
 *
 * Fed the tensor Python already produced, so the resize filter is out of the
 * picture and any difference is the runtime itself. This is the one that proves
 * the port; everything else can be plausible and still be a different matte.
 */
export async function compareTensor({ ort, session }) {
  const [tb, pb] = await Promise.all([
    fetch('/_ref/tensor.bin').then(r => r.arrayBuffer()),
    fetch('/_ref/pred.bin').then(r => r.arrayBuffer()),
  ]);
  const tensor = new Float32Array(tb);
  const ref = new Float32Array(pb);

  const t0 = performance.now();
  const out = await M.predict(ort, session, tensor);
  const ms = performance.now() - t0;

  let maxAbs = 0, sum = 0, over = 0;
  for (let i = 0; i < ref.length; i++) {
    const d = Math.abs(out[i] - ref[i]);
    if (d > maxAbs) maxAbs = d;
    sum += d;
    if (d > 1e-3) over++;
  }
  return {
    ms, n: ref.length, maxAbs, meanAbs: sum / ref.length,
    overPct: (over / ref.length) * 100,
    first: [out[0], ref[0]],
  };
}

/**
 * Test B -- the whole browser pipeline against Python's mask.
 *
 * This one CAN differ, because the browser resizes with a canvas filter and PIL
 * uses LANCZOS. The thresholds in the test say how much that is allowed to cost.
 */
export async function runPipeline({ ort, session }) {
  const bitmap = await fetch('/_ref/input.png').then(r => r.blob()).then(createImageBitmap);

  const t0 = performance.now();
  const res = await M.cutout(ort, session, bitmap,
    { width: bitmap.width, height: bitmap.height });
  const ms = performance.now() - t0;

  const refImg = await fetch('/_ref/mask.png').then(r => r.blob()).then(createImageBitmap);
  const c = new OffscreenCanvas(refImg.width, refImg.height);
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(refImg, 0, 0);
  const { data } = cx.getImageData(0, 0, refImg.width, refImg.height);

  let maxAbs = 0, sum = 0, over8 = 0, opaque = 0;
  for (let p = 0, i = 0; p < res.alpha.length; p++, i += 4) {
    const d = Math.abs(res.alpha[p] - data[i]);
    if (d > maxAbs) maxAbs = d;
    sum += d;
    if (d > 8) over8++;
    if (data[i] > 127) opaque++;
  }
  return {
    ms, marks: res.marks, w: res.width, h: res.height,
    maxAbs, meanAbs: sum / res.alpha.length,
    over8Pct: (over8 / res.alpha.length) * 100,
    opaquePct: (opaque / res.alpha.length) * 100,
  };
}
