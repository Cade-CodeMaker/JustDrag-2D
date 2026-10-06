/*
 * The animation maths behind the GIF export.
 *
 *   A. swing    the extracted formula still equals the one stage.js used inline,
 *               and each ellipse reads its own amplitude / speed / lag
 *   B. timing   frame count and centisecond delays, so playback is not silently
 *               off-speed
 *   C. framing  the square the shader draws, in pixels
 *   D. seam     the loop wraps where it is supposed to
 *
 * This is the only test in the repo that needs no browser, no Chrome and no
 * ONNX model -- pose.js is pure, so Node imports it directly and the whole
 * thing runs in milliseconds. That is what makes it affordable to sweep the
 * seam over thousands of phases here rather than eyeballing a GIF.
 *
 * Run:  node app/test/pose.test.js
 */
import { swing, poseAngles, framePlan, phasesFor, frameRect, fitZoom, seamAt, bestStartPhase,
         GIF_FPS, GIF_SIZES, GIF_SECONDS } from '../src/pose.js';

let fails = 0;
function check(label, ok, detail) {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail !== undefined ? '   -> ' + detail : ''}`);
  if (!ok) fails++;
}

/** One ellipse, with the defaults from src/regions.js BLOB_PARAMS. */
const blob = (amp = 3.5, spd = 1, delay = 0) => ({ amp, spd, delay });

/**
 * The shape the shipped default_regions.json has: one ellipse for the head,
 * two sharing a lag for the legs. Reproduces the old
 * `hAmp 3.5, hSpd 1, lAmp 4.5, lSpd 0.85, phase 0.5`, which is the config every
 * number below was measured against.
 */
const DEF = [blob(3.5, 1, 0), blob(4.5, 0.85, 0.5), blob(4.5, 0.85, 0.5)];
const HARM = 0.22;

console.log('--- A. swing matches the formula it replaced ---');
{
  // Verbatim the expression that was inline in Stage.draw(), so a slip during
  // the extraction shows up here instead of as a GIF that moves oddly.
  const original = (amp, spd, ph, harm, t) => {
    const tau = Math.PI * 2;
    const a = Math.sin(tau * (t * spd + ph));
    return amp * (a + harm * Math.sin(2 * tau * (t * spd + ph))) / (1 + harm);
  };

  let worst = 0;
  for (let t = 0; t < 20; t += 0.037) {
    for (const [amp, spd, ph, harm] of [[3.5, 1, 0, 0.22], [4.5, 0.85, 0.5, 0.22],
                                        [0, 0, 0, 0], [14, 3, 1, 0.6], [2, 0.33, 0.17, 0]]) {
      worst = Math.max(worst, Math.abs(swing(amp, spd, ph, harm, t) - original(amp, spd, ph, harm, t)));
    }
  }
  check('identical over a grid of amps/speeds/lags/harmonics', worst < 1e-12, `max |diff| ${worst}`);

  // The unit of motion is the ellipse: the angle list is indexed the same way
  // the weight texture packs channels, so a caller can hand it straight to the
  // per-blob shader uniforms.
  const p = poseAngles(DEF, HARM, 1.234);
  check('poseAngles returns one angle per ellipse, in order',
    p.length === DEF.length &&
    p[0] === swing(3.5, 1, 0, HARM, 1.234) &&
    p[1] === swing(4.5, 0.85, 0.5, HARM, 1.234) &&
    p[2] === p[1]);
  check('zero amplitude gives a still ellipse',
    poseAngles([blob(0, 1, 0.3)], HARM, 2.5)[0] === 0);

  // The animation-level half of the equivalence claim in the plan: while every
  // ellipse in a region still shares one amplitude / speed / lag -- which is
  // what the shipped defaults and the bulk slider both produce -- the per-blob
  // angles are indistinguishable from the old per-region ones, so the shader's
  // sum telescopes back to exactly the old expression.
  const spread = [blob(3.5, 1, 0), blob(3.5, 1, 0), blob(3.5, 1, 0)];
  let worstSpread = 0;
  for (let t = 0; t < 12; t += 0.05) {
    const a = poseAngles(spread, HARM, t);
    for (let i = 1; i < a.length; i++) worstSpread = Math.max(worstSpread, Math.abs(a[i] - a[0]));
  }
  check('ellipses sharing amp/speed/lag are bit-identical at every t',
    worstSpread === 0, `max |diff| ${worstSpread}`);

  // And the converse: give one of them its own lag and they come apart. Without
  // this the feature is untested.
  const lagged = [blob(3.5, 1, 0), blob(3.5, 1, 0.25)];
  let maxSplit = 0;
  for (let t = 0; t < 12; t += 0.05) {
    const a = poseAngles(lagged, HARM, t);
    maxSplit = Math.max(maxSplit, Math.abs(a[1] - a[0]));
  }
  check('a different lag actually pulls an ellipse out of step',
    maxSplit > 1, `max split ${maxSplit.toFixed(3)}°`);
}

console.log('\n--- B. frame timing ---');
{
  const plan = framePlan(10, 5);
  check('10fps x 5s -> 50 frames, 10cs, exactly 5.000s',
    plan.n === 50 && plan.delayCs === 10 && plan.actualSeconds === 5,
    JSON.stringify(plan));

  // The property that matters: every offered rate is a whole number of
  // centiseconds, so the GIF plays at the speed the label claims.
  let allExact = true, offBy = 0;
  for (const fps of GIF_FPS) {
    if (!Number.isInteger(100 / fps)) { allExact = false; offBy = fps; }
  }
  check('every offered frame rate is a whole number of centiseconds', allExact, offBy || '');

  // And the reported duration must come from the delay actually written.
  let worstDrift = 0, n = 0;
  for (const fps of GIF_FPS) for (const s of GIF_SECONDS) {
    const p = framePlan(fps, s);
    worstDrift = Math.max(worstDrift, Math.abs(p.actualSeconds - p.n * p.delayCs / 100));
    n++;
  }
  check(`actualSeconds always equals n x delayCs (${n} combos)`, worstDrift < 1e-12, `max drift ${worstDrift}`);

  // A duration only survives untouched when its frame count comes out whole.
  // The rest are reported as the real duration, not rounded back to the ask.
  let whole = 0, wholeOk = 0, rounded = 0, roundedOk = 0;
  for (const fps of GIF_FPS) for (const s of GIF_SECONDS) {
    const p = framePlan(fps, s);
    if (Math.abs(s * 100 / p.delayCs - p.n) < 1e-9) {
      whole++;
      if (Math.abs(p.actualSeconds - s) < 1e-9) wholeOk++;
    } else {
      rounded++;
      if (p.actualSeconds !== s) roundedOk++;
    }
  }
  check('durations that divide evenly come back unchanged', whole > 0 && whole === wholeOk,
    `${wholeOk}/${whole}`);
  check('durations that do not are reported as the real length, never the ask',
    rounded > 0 && rounded === roundedOk, `${roundedOk}/${rounded} differ from the requested seconds`);

  const ph = phasesFor(50, 10, 0.25);
  check('phases step by exactly one delay', ph.length === 50 && ph[49] === 0.25 + 49 * 0.1 && ph[0] === 0.25);
}

console.log('\n--- C. the square the shader frames ---');
{
  const full = frameRect(512, 512, 1);
  check('zoom 1 covers the whole frame', full[0] === 0 && full[2] === 512, `[${full}]`);

  const out = frameRect(512, 512, 0.5);
  check('zoom 0.5 leaves a symmetric margin (the pixels that must be filled)',
    out[0] === 128 && out[1] === 128 && out[2] === 384 && out[3] === 384, `[${out}]`);

  const over = frameRect(512, 512, 1.3);
  check('zoom 1.3 covers, so nothing is filled', over[0] < 0 && over[2] > 512, `[${over}]`);

  // deform.glsl centres per axis: org = (uRes - side) / 2 on x and y separately.
  const wide = frameRect(800, 600, 1);
  check('a non-square frame centres on both axes, like the shader',
    wide[0] === 100 && wide[1] === 0 && wide[2] === 700 && wide[3] === 600, `[${wide}]`);

  // The bug this exists for: the preview is framed at params.zoom, and at
  // zoom > 1 the square is bigger than the frame, which the shader turns into
  // a crop of the art's centre. Square exports have no window slack to hide
  // that in, so they frame at fitZoom instead.
  check('fitZoom leaves anything at or below 1 alone',
    fitZoom(0.4) === 0.4 && fitZoom(0.85) === 0.85 && fitZoom(1) === 1);
  check('fitZoom clamps the zoom that would crop the art',
    fitZoom(1.3) === 1 && fitZoom(2) === 1);

  let worst = null;
  for (const size of GIF_SIZES) {
    for (let z = 40; z <= 130; z++) {          // the whole slider, in its own units
      const r = frameRect(size, size, fitZoom(z / 100));
      if (r[0] < 0 || r[1] < 0 || r[2] > size || r[3] > size) worst = `${size}px @ ${z}% -> [${r}]`;
    }
  }
  check('at the export zoom the square always fits inside the frame, slider-wide',
    worst === null, worst || `${GIF_SIZES.length * 91} combinations`);
}

console.log('\n--- D. the loop seam ---');
{
  const T = 5;
  // Starting at phase 0 is what the naive export would do. This is the jump the
  // user was told to expect.
  const naive = seamAt(DEF, HARM, 0, T);
  check('phase 0 leaves the documented leg seam',
    Math.abs(naive.per[1] - (-3.6885)) < 1e-3, `${naive.per[1].toFixed(4)}°`);

  // The head ellipse's spd * T is a whole number, so its term cancels for ANY
  // start phase.
  let headWorst = 0;
  for (let phi = 0; phi < 1; phi += 0.013) {
    headWorst = Math.max(headWorst, Math.abs(seamAt(DEF, HARM, phi, T).per[0]));
  }
  check('head seam is identically zero when spd*T is whole, for every phase',
    headWorst < 1e-12, `max ${headWorst}`);

  const phi = bestStartPhase(DEF, HARM, T);
  const best = seamAt(DEF, HARM, phi, T);
  check('bestStartPhase finds the zero of the leg seam',
    best.max < 1e-6, `phi=${phi.toFixed(6)} seam=${best.max.toExponential(2)}°`);

  // The guarantee in the docstring: a root exists, so every duration should do
  // this well when the head ellipse's speed is 1.
  let worstAtBest = 0, worstSec = 0;
  for (const s of [2, 3, 4, 5, 6, 8, 10]) {
    const c = seamAt(DEF, HARM, bestStartPhase(DEF, HARM, s), s).max;
    if (c > worstAtBest) { worstAtBest = c; worstSec = s; }
  }
  check('every whole-second duration can be made seamless', worstAtBest < 1e-6,
    `worst ${worstAtBest.toExponential(2)}° at ${worstSec}s`);

  // Head speed that does not divide the duration: one phase cannot zero both,
  // so this only has to be better than doing nothing.
  const odd = [blob(3.5, 2.7, 0), blob(4.5, 0.85, 0.5)];
  const oddBest = seamAt(odd, HARM, bestStartPhase(odd, HARM, 4), 4).max;
  const oddNaive = seamAt(odd, HARM, 0, 4).max;
  check('a non-dividing head speed still improves on phase 0',
    oddBest < oddNaive, `${oddNaive.toFixed(3)}° -> ${oddBest.toFixed(3)}°`);

  // What per-ellipse lag costs. Each ellipse's seam still has a root of its own,
  // but the roots sit at different phases, so the worst-of-all cannot reach
  // zero the way a single shared lag can. This is the documented limit -- the
  // export reports the residual instead of pretending.
  const split = [blob(4.5, 0.85, 0), blob(4.5, 0.85, 0.31)];
  const splitAt = bestStartPhase(split, HARM, T);
  const splitBest = seamAt(split, HARM, splitAt, T);
  const splitNaive = seamAt(split, HARM, 0, T);
  check('lagging ellipses apart still beats phase 0',
    splitBest.max < splitNaive.max, `${splitNaive.max.toFixed(3)}° -> ${splitBest.max.toFixed(3)}°`);
  check('but the residual is honestly non-zero, unlike a shared lag',
    splitBest.max > 1e-3, `${splitBest.max.toFixed(4)}° left over`);
}

console.log('\n--- E. the panel tables stay sane ---');
{
  check('sizes are square-friendly and within WebGL1 guarantees',
    GIF_SIZES.every(s => s >= 64 && s <= 2048), GIF_SIZES.join('/'));
  check('no offered frame rate is faster than the 2cs floor',
    GIF_FPS.every(f => 100 / f >= 2), GIF_FPS.join('/'));
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
