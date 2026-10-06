/**
 * The animation maths, on its own.
 *
 * `swing` used to be inline in Stage.draw(). It lives here now so the live
 * preview and the GIF exporter evaluate the same expression -- two copies of
 * this would drift, and the drift would only show up as "the GIF moves
 * differently from the preview", which is the kind of bug nobody reports
 * precisely.
 *
 * The unit is the **ellipse**, not the region: each one owns its amplitude,
 * speed and lag, so the two legs of a figure can swing out of step. Nothing
 * here knows which region an ellipse belongs to -- it only needs the list, in
 * the order the weight texture packs them (see `flatBlobs` in regions.js).
 *
 * Nothing here touches WebGL or the DOM, so Node can import it directly. That
 * makes these the only tests in the repo that need no browser and no model.
 */

export const TAU = Math.PI * 2;

/**
 * One ellipse's angle in degrees, at time `t` seconds.
 *
 * `harm` mixes in a second harmonic at 2x -- the "naturalness" slider. Dividing
 * by (1 + harm) keeps the peak amplitude at `amp` for any `harm`, so the slider
 * changes the shape of the swing without changing how far it swings.
 */
export function swing(amp, spd, phaseOffset, harm, t) {
  const a = Math.sin(TAU * (t * spd + phaseOffset));
  return amp * (a + harm * Math.sin(2 * TAU * (t * spd + phaseOffset))) / (1 + harm);
}

/**
 * Every ellipse's angle, in degrees, at an explicit time in seconds.
 *
 * The index of the result is the ellipse's weight-texture channel, so callers
 * can hand it straight to the shader's per-blob uniforms.
 */
export function poseAngles(blobs, harm, t) {
  const out = new Float64Array(blobs.length);
  for (let i = 0; i < blobs.length; i++) {
    const b = blobs[i];
    out[i] = swing(b.amp, b.spd, b.delay, harm, t);
  }
  return out;
}

/**
 * Frame rates a GIF can actually play at the rate they claim.
 *
 * A frame delay is stored in centiseconds, so only rates dividing 100 are
 * exact: 10 -> 10cs, 12.5 -> 8cs, 20 -> 5cs, 25 -> 4cs. Anything else rounds,
 * and the animation then runs at a speed nobody asked for.
 *
 * Nothing faster than 25: below 2cs a number of viewers quietly rewrite the
 * delay to 10cs, which turns a smooth loop into a slideshow.
 */
export const GIF_FPS = [10, 12.5, 20, 25];

/** Output sizes offered in the panel. Square, like the shader's framing. */
export const GIF_SIZES = [256, 384, 512, 768];

/** Durations offered in the panel, in seconds. */
export const GIF_SECONDS = [2, 3, 4, 5, 6, 8, 10];

/**
 * Turn a requested fps/duration into a frame count and a real delay.
 *
 * `actualSeconds` is what the GIF will really take, computed from the delay
 * that actually gets written -- not from the number the user picked. The two
 * agree for every rate in GIF_FPS; when they would not, the panel says so
 * rather than pretending.
 */
export function framePlan(fps, seconds) {
  const delayCs = Math.round(100 / fps);
  const n = Math.max(1, Math.round(seconds * 100 / delayCs));
  return { n, delayCs, actualSeconds: n * delayCs / 100 };
}

/** The phase of each frame: start, then one delay apart. */
export function phasesFor(n, delayCs, startPhase) {
  const step = delayCs / 100;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) out[k] = startPhase + k * step;
  return out;
}

/**
 * The square the shader frames, in pixels, as [x0, y0, x1, y1].
 *
 * Mirrors deform.glsl: `side = min(w, h) * zoom`, centred **per axis** -- org
 * is `(uRes - side) / 2` on x and y independently, so a non-square frame puts
 * the square in the middle of both. The export only ever asks for a square
 * frame, where the two agree; the per-axis form is here so that a future
 * caller with a non-square frame gets the shader's answer rather than a
 * plausible-looking wrong one.
 *
 * The caller uses it to find the pixels the shader writes as transparent --
 * see the fill in stage.js. At zoom >= 1 the rect covers the whole frame and
 * nothing is filled.
 */
export function frameRect(w, h, zoom) {
  const side = Math.min(w, h) * zoom;
  const ox = (w - side) / 2, oy = (h - side) / 2;
  return [ox, oy, ox + side, oy + side];
}

/**
 * The zoom an *export* is framed at, as opposed to the zoom the preview is
 * framed at.
 *
 * The framing square is `min(w, h) * zoom` and the image maps onto it in full,
 * so the square is the whole artwork and zoom only says how much of the
 * viewport that square covers. Below 1 it is a margin; above 1 the square is
 * bigger than the viewport and the shader's own bounds test (deform.glsl:29)
 * turns zoom into a crop of the central 1/zoom.
 *
 * The preview can afford that because its viewport is the browser window --
 * wider than the square, so at zoom > 1 you keep the full width and lose only
 * the top and bottom. A square export has no such slack: it is the square, so
 * zoom > 1 eats all four edges and the delivered GIF comes out as a crop of
 * the art. Clamping means "as large as will fit": below 1 nothing changes
 * (the user asked for that margin), above 1 the art stops growing instead of
 * going missing.
 *
 * A crop is not offered at all, rather than offered with a warning, because
 * the only way to ask for one is to zoom the *preview*, which is an editor
 * window decision -- the export panel has no control that means "crop".
 */
export function fitZoom(zoom) {
  return Math.min(zoom, 1);
}

/**
 * How far the pose jumps when the GIF wraps, per ellipse, plus the worst one.
 *
 * The frame shown last is at t0 + T - delay, and the one after it is at t0
 * again. A smooth animation would have continued to t0 + T, so the excess
 * motion at the wrap is exactly this difference. Magnitude is what matters;
 * the sign only says which way it jumps.
 *
 * The `max` is what the start-phase search minimises. It used to be the worse
 * of two regions; now it is the worst of every ellipse, which is a strictly
 * harder target -- see bestStartPhase.
 */
export function seamAt(blobs, harm, startPhase, T) {
  const a = poseAngles(blobs, harm, startPhase);
  const b = poseAngles(blobs, harm, startPhase + T);
  const per = new Float64Array(blobs.length);
  let max = 0;
  for (let i = 0; i < blobs.length; i++) {
    per[i] = b[i] - a[i];
    if (Math.abs(per[i]) > max) max = Math.abs(per[i]);
  }
  return { per, max };
}

/**
 * The start phase that makes the loop wrap as smoothly as possible.
 *
 * This is not an animation parameter and it changes nothing the user tuned --
 * it only decides which instant of the cycle the recording begins at. The
 * preview is untouched until the button is pressed.
 *
 * Why there is usually a perfect answer: with `u = t * spd + delay` and
 * `g(u) = sin(2*pi*u) + harm*sin(4*pi*u)`, one ellipse's seam is
 * `d(u) = g(u + spd*T) - g(u)`. Since g has period 1, d has zero mean over a
 * period; a continuous zero-mean function is either identically zero or takes
 * both signs, so it has a root. Every ellipse individually can be driven to
 * zero for any `spd*T` that is not a whole number (and is already zero when it
 * is).
 *
 * What changed when ellipses got their own lag: the roots are generally at
 * *different* phases, and we minimise the worst ellipse rather than the worse
 * of two regions. So distinct lag values can leave a residual that no single
 * phase removes. That is honest rather than broken -- the caller reports the
 * angle it actually reached, the same way it always has. With the shipped
 * defaults (lag 0 for the head, one shared value for the legs' ellipses) every
 * ellipse in a region shares a root and the result is unchanged.
 *
 * Honest limit: this makes the loop positionally continuous, not
 * velocity-continuous. The wrap step equals a normal frame step, so there is
 * no jump, but an ellipse mid-swing can reverse direction there. That reads as
 * a faint hitch at low frame rates -- a completely different thing from the
 * ~21px jump that starting at phase 0 produces.
 */
export function bestStartPhase(blobs, harm, T, samples = 2000) {
  const cost = phi => seamAt(blobs, harm, phi, T).max;

  // Coarse sweep of a full cycle, then narrow onto the winner. Three passes
  // gets the residual to ~1e-9 of a cycle, far below anything visible.
  let lo = 0, hi = 1, best = 0, bestCost = Infinity;
  for (let pass = 0; pass < 3; pass++) {
    const n = samples;
    const step = (hi - lo) / n;
    bestCost = Infinity;
    for (let i = 0; i <= n; i++) {
      const phi = lo + i * step;
      const c = cost(phi);
      if (c < bestCost) { bestCost = c; best = phi; }
    }
    lo = Math.max(0, best - step);
    hi = best + step;
  }
  return best;
}
