/*
 * The soft-ellipse weight field, in JavaScript -- the half the browser runs.
 *
 * A region is the union of rotated soft ellipses ("blobs"): weight 1.0 inside
 * INNER radii, falling linearly to 0.0 at OUTER radii, taking the max over
 * blobs. Continuous, so there is no cut line anywhere -- which is what makes
 * this work on art whose braid and ribbon span the whole body.
 *
 * The texture has **one channel per ellipse**, not one per region, so two
 * ellipses inside one region can swing out of step. That costs the property
 * the old layout had for free -- that a region's channel was exactly its
 * coverage -- so the bake below restores it arithmetically: each channel is
 * scaled by k_r = M_r / S_r, which makes the region's channels sum back to the
 * region's old single-channel value. See DESIGN for the derivation and for
 * what quantisation does to it.
 *
 * Python has a port of this exact field (core/region_field.py) used as an
 * offline oracle. Neither generates the other; verify/test_weight_golden.*
 * asserts they agree, so a drift in either fails a test instead of quietly
 * shipping a wrong picture.
 *
 * UMD-lite so the same file works both inlined into the page and require()d
 * by the Node tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DeformCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const INNER = 0.75, OUTER = 1.35;   // blob falloff band, in radii

  /** One ellipse's own weight: 1.0 inside INNER radii, 0.0 at OUTER. */
  function blobWeight(x, y, b) {
    // A degenerate ellipse has to contribute nothing rather than NaN. Its own
    // channel would be the only casualty in the old layout, but the bake sums
    // the region's weights to get k, so a NaN here would zero every channel in
    // the region and silently freeze the whole body part.
    const rx = b.r[0], ry = b.r[1];
    if (!(rx > 0) || !(ry > 0)) return 0;   // also catches NaN

    const th = b.rot * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
    const dx = x - b.c[0], dy = y - b.c[1];
    const qx = dx * c + dy * s, qy = -dx * s + dy * c;
    const d = Math.hypot(qx / rx, qy / ry);
    return Math.min(1, Math.max(0, 1 - (d - INNER) / (OUTER - INNER)));
  }

  /**
   * A region's coverage: the max over its ellipses.
   *
   * Nothing is scaled by this any more -- every ellipse has its own channel --
   * but it is still the M the bake divides by, and still the value the region's
   * channels sum to, so it is what a test compares them against.
   */
  function regionW(x, y, reg) {
    let w = 0;
    for (const b of reg.blobs) {
      const v = blobWeight(x, y, b);
      if (v > w) w = v;
    }
    return w;
  }

  /** RGBA textures needed to hold `n` ellipses. At least one, so the shader has something to bind. */
  function textureCount(n) {
    return Math.max(1, Math.ceil(n / 4));
  }

  /**
   * The `#define` block that specialises core/deform.glsl for this ellipse count.
   *
   * The shader cannot index a sampler array portably -- glsl-optimizer and Mesa
   * have shipped builds that reject it, and ES 3.00 forbids it outright -- so
   * the number of textures has to be a compile-time constant that selects a
   * ladder of named samplers. Both callers already have this module in scope
   * and prepend the result to the shader source, which is why the build path
   * needs no variant plumbing of its own.
   *
   * `N_BLOB` sizes the uniform arrays and is the real ellipse count, so a
   * project with 4 ellipses declares 4 -- not the 4-multiple it is padded to
   * for the loop. Loop index `i < N_BLOB` would still be in range; `i >= N_BLOB`
   * only ever happens behind a zero weight, and the shader's `if` is what keeps
   * the index out of the array at all. Sizing to the padded count instead would
   * cost up to 3 wasted vec4 pairs, which is real budget on weak hardware.
   */
  function shaderDefines(nBlob) {
    const n = Math.max(1, Math.floor(nBlob) || 0);
    return `#define N_WTEX ${textureCount(n)}\n#define N_BLOB ${n}\n`;
  }

  /**
   * Every ellipse, region by region and, within a region, in array order.
   *
   * This order **is** the channel order, and it is a contract shared with
   * regions.js and with core/region_field.py -- verify/test_weight_golden.js is
   * what keeps the two implementations honest about it.
   *
   * Returns `{ blobs, regs }` as parallel arrays rather than one merged list so
   * a caller that only needs the channels does not pay for the pairing.
   */
  function flatBlobs(regions) {
    const blobs = [], regs = [];
    for (const reg of regions) {
      for (const b of reg.blobs) { blobs.push(b); regs.push(reg); }
    }
    return { blobs, regs };
  }

  /** Byte offset of flat ellipse channel `c` inside the concatenated buffers. */
  function channelAt(c, pixel, size) {
    return (Math.floor(c / 4) * size * size + pixel) * 4 + (c % 4);
  }

  /**
   * Rasterise to the RGBA textures the shader samples.
   *
   * Layout: four channels per texture, textures back to back, channel `c`
   * living at component `c % 4` of texture `floor(c / 4)`. Returns
   * `textureCount(n) * size * size * 4` bytes -- one contiguous buffer that a
   * caller can either upload in pieces or read as a whole.
   *
   * The units are ellipses, not regions: channel `c` is the `c`-th ellipse in
   * flatBlobs() order. Each region's channels are scaled by `k = M / S` so
   * that they sum to the region's coverage -- exactly the value the region
   * would have had as a single channel. With one ellipse the factor is w/w,
   * which is exactly 1.0 in IEEE, so that case is bit-identical to never
   * having scaled at all.
   *
   * Quantisation: each channel is truncated once, after the multiply. n_r
   * separately truncated terms can therefore fall short of the region's
   * coverage by at most n_r - 1 LSB, and never overshoot it. That is the bound
   * verify/compare_equivalence.js measures against.
   */
  function rasterize(regions, size) {
    const px = size * size;

    // Region ranges in channel order, in one pass so the layout is stated once.
    const spans = [];
    let total = 0;
    for (const reg of regions) {
      spans.push({ blobs: reg.blobs, lo: total, n: reg.blobs.length });
      total += reg.blobs.length;
    }

    const data = new Uint8Array(textureCount(total) * px * 4);
    const ws = [];   // one region's per-ellipse weights, reused between pixels

    for (const span of spans) {
      const { blobs, lo, n } = span;
      if (!n) continue;
      for (let j = 0; j < size; j++) {
        const y = (j + 0.5) / size;        // row 0 = top of image, no FLIP_Y anywhere
        for (let i = 0; i < size; i++) {
          const x = (i + 0.5) / size;
          const pixel = j * size + i;

          // Sequential, in blob order: the Python port has to sum identically,
          // so nothing here may be reordered or reassociated.
          let M = 0, S = 0;
          for (let b = 0; b < n; b++) {
            const w = blobWeight(x, y, blobs[b]);
            ws[b] = w;
            S += w;
            if (w > M) M = w;
          }
          const k = S > 0 ? M / S : 0;
          for (let b = 0; b < n; b++) {
            data[channelAt(lo + b, pixel, size)] = 255 * ws[b] * k;
          }
        }
      }
    }
    return data;
  }

  return { INNER, OUTER, blobWeight, regionW, textureCount, shaderDefines,
           flatBlobs, rasterize };
});
