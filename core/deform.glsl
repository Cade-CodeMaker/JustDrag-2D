#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

// How many RGBA weight textures the field was rasterised into.
//
// The page prepends DeformCore.shaderDefines(nBlob) before compiling, so the
// variant is chosen at compile time by the only code that knows how many
// ellipses there are. The defaults keep this file compilable on its own, which
// is what lets the oracle and golden paths inline it verbatim.
#ifndef N_WTEX
#define N_WTEX 1
#endif
// How many ellipses actually exist. The uniform arrays are sized to this, not
// to the padded count, so a project with 4 ellipses pays for 4.
#ifndef N_BLOB
#define N_BLOB (N_WTEX * 4)
#endif
// How far the loop runs: channels are padded out to whole textures, and
// everything above N_BLOB reads as 0, so the loop can run to the padded bound
// without knowing N_BLOB. A zero weight contributes nothing to any of the three
// accumulators -- and, because the if guards the only array index, the
// padding slots are never addressed at all. That makes the padding free rather
// than merely harmless.
#define N_SLOT (N_WTEX * 4)

uniform sampler2D uTex;      // character, image space (y down)
// One texture per four ellipses. Named rather than an array on purpose: a
// sampler array indexed by a loop variable is not portable -- glsl-optimizer
// and Mesa have shipped builds that reject it, and ES 3.00 forbids it outright.
uniform sampler2D uWeight0;
#if N_WTEX > 1
uniform sampler2D uWeight1;
#endif
#if N_WTEX > 2
uniform sampler2D uWeight2;
#endif
#if N_WTEX > 3
uniform sampler2D uWeight3;
#endif
#if N_WTEX > 4
uniform sampler2D uWeight4;
#endif
#if N_WTEX > 5
uniform sampler2D uWeight5;
#endif
#if N_WTEX > 6
uniform sampler2D uWeight6;
#endif

uniform vec2 uRes;              // canvas size, px
// Packed as vec4 rather than vec2/vec3 so the array stride is unambiguous.
// GLSL ES 1.00 does not pin down how arrays of smaller types are packed into
// uniform storage, and drivers have disagreed; a vec4 array is the one case
// where "tightly packed" and "one slot per element" are the same thing.
uniform vec4 uBlobXform[N_BLOB];   // (pivot.x, pivot.y, cos, sin)
uniform vec4 uBlobColor[N_BLOB];   // (r, g, b, unused) -- region colour, for uMode
uniform float uZoom;
uniform int   uMode;         // 0 = animate, 1 = show weights
uniform int   uBg;           // 0 checker, 1 dark, 2 light

// How far this pixel has to move, given the ellipse's weight. Zero at the
// pivot by construction: d is (img - pivot), so the bracket vanishes there.
vec2 blobOffset(vec2 img, vec4 xf){
  vec2 d = img - xf.xy;
  return vec2(d.x * xf.z + d.y * xf.w, -d.x * xf.w + d.y * xf.z) - d;
}

// One ellipse's contribution. A macro rather than a function so the four
// channels of each texture can be spelled out with literal indices, which is
// what keeps this off the sampler-array question entirely.
#define ACCUM(w_, i_) { \
    float w = (w_); \
    if (w > 0.0) { \
      acc += w * blobOffset(img, uBlobXform[i_]); \
      tint += w * uBlobColor[i_].rgb; \
      total += w; \
    } \
  }

void main(){
  // fit the square image inside the canvas, letterboxed
  float side = min(uRes.x, uRes.y) * uZoom;
  vec2 org = (uRes - vec2(side)) * 0.5;
  // p = square-normalised, y up.  img = image space, y down (matches regions.json)
  vec2 p = (gl_FragCoord.xy - org) / side;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) { gl_FragColor = vec4(0.0); return; }
  vec2 img = vec2(p.x, 1.0 - p.y);

  vec2 acc = vec2(0.0);     // weighted sum of source offsets
  float total = 0.0;        // sum of weights, over every ellipse
  vec3 tint = vec3(0.0);    // weighted sum of colours -- see uMode below

  for (int t = 0; t < N_WTEX; t++) {
    vec4 wv = vec4(0.0);
    if (t == 0) wv = texture2D(uWeight0, img);
#if N_WTEX > 1
    else if (t == 1) wv = texture2D(uWeight1, img);
#endif
#if N_WTEX > 2
    else if (t == 2) wv = texture2D(uWeight2, img);
#endif
#if N_WTEX > 3
    else if (t == 3) wv = texture2D(uWeight3, img);
#endif
#if N_WTEX > 4
    else if (t == 4) wv = texture2D(uWeight4, img);
#endif
#if N_WTEX > 5
    else if (t == 5) wv = texture2D(uWeight5, img);
#endif
#if N_WTEX > 6
    else if (t == 6) wv = texture2D(uWeight6, img);
#endif
    ACCUM(wv.r, t * 4 + 0);
    ACCUM(wv.g, t * 4 + 1);
    ACCUM(wv.b, t * 4 + 2);
    ACCUM(wv.a, t * 4 + 3);
  }

  // Inverse map: for this output pixel, where do we read from? A forward
  // (scatter) map would leave holes and overlaps; this direction gives every
  // output pixel exactly one source, so there is no seam to feather. Motion
  // dies out at the pivots by construction, which is why placing them at the
  // joints needs no extra smoothing.
  //
  // Dividing the sum rather than each term keeps the blend convex where
  // regions overlap, so displacement cannot overshoot. It is the same result
  // the per-region layout produced: the bake makes a region's channels sum to
  // its coverage, so the total here is the old wh + wl.
  vec2 src = img + acc / max(1.0, total);

  vec4 col = texture2D(uTex, src);

  if (uMode == 1) {
    // tint sums w_i * color_i, which the bake makes equal to the per-region
    // coverage blend -- so a pixel shows the colour of whichever region owns
    // it, at the strength it owns it. The colours come from each region's own
    // color; the layout this replaced hardcoded a blue and an orange that
    // did not match regions.json.
    col = vec4(mix(vec3(0.09), tint / max(1.0, total), min(1.0, total)), 1.0);
  }

  // backdrop behind the character
  vec3 bg;
  if (uBg == 0) {
    float c = mod(floor(p.x * side / 16.0) + floor(p.y * side / 16.0), 2.0);
    bg = mix(vec3(0.345), vec3(0.518), c);
  } else if (uBg == 1) { bg = vec3(0.125); }
  else { bg = vec3(0.90); }

  gl_FragColor = vec4(mix(bg, col.rgb, col.a), 1.0);
}
