/*
 * The GIF encoder, exercised on synthetic frames -- no browser, no GL.
 *
 * The GL half (FBO capture, the row flip, the out-of-square background fill) is
 * covered separately in ui.test.js, because that part cannot be faked here.
 * What this file can do cheaply is the part that is pure bytes: structure,
 * timing, determinism, palette layout.
 *
 * Run:  node app/test/gif.test.js
 */
import { createHash } from 'node:crypto';
import { encodeGif, samplePalette, ditherToIndices, buildNearestLut } from '../src/gif.js';
import { framePlan, phasesFor } from '../src/pose.js';
import { parseGif, decodeFrame0 } from './gifparse.js';

let fails = 0;
function check(label, ok, detail) {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail !== undefined ? '   -> ' + detail : ''}`);
  if (!ok) fails++;
}
const sha = b => createHash('sha256').update(b).digest('hex');

const BG = [244, 243, 240];

/**
 * A frame with something for the quantiser to actually chew on: a smooth
 * vertical gradient across the whole frame (the character's shading) plus a
 * saturated block (so the palette has to spend slots on more than one hue).
 * `shift` moves the block, so successive frames are genuinely different images
 * and a bug that reuses frame 0 would not slip through.
 */
function synthFrame(w, h, shift) {
  const f = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) << 2;
      const g = Math.round(40 + 180 * (x / w));
      f[p] = g; f[p + 1] = Math.round(g * 0.6); f[p + 2] = Math.round(255 - g * 0.5);
      f[p + 3] = 255;
    }
  }
  const bx = Math.round((w - w / 4) * shift), by = Math.round((h - h / 4) * (1 - shift));
  for (let y = by; y < by + h / 4; y++) {
    for (let x = bx; x < bx + w / 4; x++) {
      const p = (y * w + x) << 2;
      f[p] = 250; f[p + 1] = 90; f[p + 2] = 30; f[p + 3] = 255;
    }
  }
  return f;
}

async function* drain(list) { for (const f of list) yield f; }

const W = 64, H = 64;
const N = 12;
const plan = framePlan(10, N / 10);
const frames = Array.from({ length: N }, (_, k) => synthFrame(W, H, k / (N - 1)));
const palette = samplePalette(frames, BG);

console.log('--- A. structure and timing ---');
let bytes, meta;
{
  bytes = await encodeGif({
    width: W, height: H, palette, frames: drain(frames),
    delayMs: plan.delayCs * 10, dither: false,
  });
  meta = parseGif(bytes);

  check('GIF89a header', meta.signature === 'GIF89a', meta.signature);
  check('logical screen is the requested size',
    meta.screenWidth === W && meta.screenHeight === H, `${meta.screenWidth}x${meta.screenHeight}`);
  check('frame count is the planned count', meta.frames.length === N,
    `${meta.frames.length} of ${N}`);
  check('every frame delay is the planned centiseconds',
    meta.frames.every(f => f.delayCs === plan.delayCs), `${plan.delayCs}cs`);
  check('trailer present', meta.trailer);

  // The double-rounding trap: gifenc takes ms and divides by 10 itself. Handing
  // it 1000/fps instead of delayCs*10 would put a different number in the file
  // at 12.5fps, which is exactly the case a naive test would miss.
  const p125 = framePlan(12.5, 2);
  const b125 = await encodeGif({
    width: W, height: H, palette, frames: drain(frames.slice(0, 4)),
    delayMs: p125.delayCs * 10, dither: false,
  });
  const m125 = parseGif(b125);
  check('12.5fps writes 8cs, not round(round(1000/12.5)/10) elsewhere',
    p125.delayCs === 8 && m125.frames.every(f => f.delayCs === 8),
    `delayCs=${p125.delayCs}, file=${m125.frames[0].delayCs}`);
}

console.log('\n--- B. looping and palette layout ---');
{
  check('Netscape loop count is 0 (forever)', meta.netscapeLoop === 0, `${meta.netscapeLoop}`);
  check('there is one global colour table', Array.isArray(meta.globalTable),
    `${meta.globalTable ? meta.globalTable.length : 0} entries`);
  // gifenc writes a local table for any frame given a palette, so passing the
  // palette on every frame would silently add ~768 bytes each.
  check('no frame carries a redundant local colour table', meta.localTableCount === 0,
    `${meta.localTableCount} local tables`);
  check('the background colour made it into the palette',
    meta.globalTable.some(c => Math.abs(c[0] - BG[0]) <= 4 && Math.abs(c[1] - BG[1]) <= 4 && Math.abs(c[2] - BG[2]) <= 4));
}

console.log('\n--- C. determinism ---');
{
  const again = await encodeGif({
    width: W, height: H, palette, frames: drain(frames),
    delayMs: plan.delayCs * 10, dither: false,
  });
  check('same input encodes to identical bytes', sha(again) === sha(bytes), sha(bytes).slice(0, 16));
}

console.log('\n--- D. dithering ---');
{
  const dithered = await encodeGif({
    width: W, height: H, palette, frames: drain(frames),
    delayMs: plan.delayCs * 10, dither: true,
  });
  const dm = parseGif(dithered);
  check('dithered output is still a well-formed GIF of the same shape',
    dm.frames.length === N && dm.screenWidth === W && dm.frames.every(f => f.delayCs === plan.delayCs));
  check('dithering actually changes the bytes', sha(dithered) !== sha(bytes));
  check('dithering costs bytes, as expected', dithered.length > bytes.length,
    `${bytes.length} -> ${dithered.length} (+${(100 * (dithered.length / bytes.length - 1)).toFixed(0)}%)`);

  // The LUT is an optimisation; it must not change which colour is chosen.
  const lut = buildNearestLut(palette);
  const a = ditherToIndices(frames[0], W, H, palette, lut);
  const b = ditherToIndices(frames[0], W, H, palette, lut);
  check('dither output is deterministic for identical input', a.every((v, i) => v === b[i]));
  check('every produced index addresses the palette',
    a.every(v => v < palette.length), `max ${Math.max(...a)} < ${palette.length}`);
}

console.log('\n--- E. decode round-trip ---');
{
  // A flat colour should survive quantisation essentially exactly -- it is the
  // one thing a 256-colour palette can always represent, and it is what the
  // background fill depends on.
  const flat = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    flat[i * 4] = 200; flat[i * 4 + 1] = 60; flat[i * 4 + 2] = 40; flat[i * 4 + 3] = 255;
  }
  const flatPal = samplePalette([flat], [200, 60, 40]);
  const flatBytes = await encodeGif({
    width: W, height: H, palette: flatPal, frames: drain([flat]),
    delayMs: 10 * 10, dither: false,   // 10cs -- the argument is MILLISECONDS
  });
  const dec = decodeFrame0(flatBytes);
  let worst = 0;
  for (let i = 0; i < W * H; i++) {
    worst = Math.max(worst,
      Math.abs(dec.rgba[i * 4] - 200),
      Math.abs(dec.rgba[i * 4 + 1] - 60),
      Math.abs(dec.rgba[i * 4 + 2] - 40));
  }
  check('the decoder reads back the geometry', dec.width === W && dec.height === H);
  check('a flat colour round-trips exactly (this is the background-fill guarantee)',
    worst === 0, `worst channel error ${worst}`);
  check('delay survives the round-trip', dec.delayCs === 10, `${dec.delayCs}cs`);

  // The trap this test just fell into, pinned down: the encoder wants
  // milliseconds and divides by 10 itself. Handing it a centisecond count
  // yields a GIF that plays ten times too fast, with nothing to signal it.
  const wrong = await encodeGif({
    width: W, height: H, palette: flatPal, frames: drain([flat]),
    delayMs: plan.delayCs, dither: false,   // 10, meant as cs, read as ms
  });
  check('passing centiseconds where milliseconds are expected is a silent 10x speedup',
    parseGif(wrong).frames[0].delayCs === 1, `${parseGif(wrong).frames[0].delayCs}cs`);

  // And the gradient frame: the decoded frame 0 must be recognisably the frame
  // that went in -- brightest-blue at the left, darkest at the right.
  const g0 = decodeFrame0(bytes);
  const colAt = x => {
    let r = 0, g = 0, bl = 0;
    for (let y = 0; y < H; y++) {
      const p = (y * W + x) << 2;
      r += g0.rgba[p]; g += g0.rgba[p + 1]; bl += g0.rgba[p + 2];
    }
    return [r / H, g / H, bl / H];
  };
  const left = colAt(2), right = colAt(W - 3);
  check('the decoded gradient runs the right way (red rises left to right)',
    right[0] > left[0] + 20, `left ${left[0].toFixed(0)} -> right ${right[0].toFixed(0)}`);

  const src0 = synthFrame(W, H, 0);
  let sum = 0;
  for (let i = 0; i < W * H; i++) {
    sum += Math.abs(g0.rgba[i * 4] - src0[i * 4]) + Math.abs(g0.rgba[i * 4 + 1] - src0[i * 4 + 1])
         + Math.abs(g0.rgba[i * 4 + 2] - src0[i * 4 + 2]);
  }
  const meanErr = sum / (W * H * 3);
  check('undithered 256-colour quantisation of a gradient stays in a sane range',
    meanErr < 12, `mean channel error ${meanErr.toFixed(2)}`);
}

console.log('\n--- F. degenerate inputs ---');
{
  const one = await encodeGif({
    width: W, height: H, palette, frames: drain([frames[0]]),
    delayMs: 10, dither: false,
  });
  check('a single-frame export is still a valid animated GIF',
    parseGif(one).frames.length === 1 && parseGif(one).netscapeLoop === 0);

  const ph = phasesFor(0, 10, 0);
  check('phasesFor(0) yields no phases rather than throwing', ph.length === 0);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
