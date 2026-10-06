/**
 * Region shapes, parameter spec, and the validation that keeps a corrupt
 * project from turning into a blank stage.
 *
 * Regions are an ordered list, and the **ellipse** -- not the region -- is the
 * unit of motion: every ellipse carries its own amplitude, speed and lag, which
 * is what lets two ellipses inside one region swing out of step. So a region is
 * a name, a pivot, a colour, and its ellipses; the region's own amp/spd is the
 * value a new ellipse inherits and the value the bulk slider writes into all of
 * them, nothing more.
 */
import { DEFAULT_REGIONS_JSON } from './core-assets.js';

/** Deep copy -- callers mutate the result freely, so a shared object would leak. */
const clone = o => JSON.parse(JSON.stringify(o));

/**
 * How many ellipses the weight texture can hold.
 *
 * Four ellipses share one RGBA texture, the shader needs one texture unit per
 * RGBA, and one more unit goes to the character itself. WebGL1 only guarantees
 * 8 texture units, so 7 * 4 = 28 is the portable ceiling. Stage asserts the
 * real device limits at startup rather than trusting this number, because the
 * fragment uniform budget binds earlier on weak hardware.
 */
export const MAX_BLOBS = 28;

/**
 * Colours handed out to newly added regions, in order.
 *
 * Only ever a starting point -- it is what makes a fresh region visible on the
 * canvas and in the weights view before anyone picks a colour. The first three
 * match the shipped default regions so a new project looks like the samples.
 */
export const REGION_COLORS = [
  [90, 200, 255], [255, 185, 70], [140, 230, 170],
  [235, 130, 190], [180, 160, 255], [255, 130, 110],
];

/** The colour a region added as number `i` starts with. */
export const regionColorAt = i => REGION_COLORS[i % REGION_COLORS.length];

/**
 * A generic standing figure, in normalized coords (y down).
 *
 * Deliberately NOT fitted to the imported image: placement is meant to be
 * hand-tuned, and a plausible-looking auto-fit that is subtly wrong is worse to
 * correct than an obvious starting shape is to drag.
 */
export function defaultRegions() {
  return clone(DEFAULT_REGIONS_JSON.regions);
}

/**
 * The motion parameters every ellipse carries, in inspector order.
 *
 * `def`/`min`/`max` are in the parameter's own units and `dec` is how many
 * decimals the readout shows. One table means the inspector and the saved
 * project cannot disagree about a range.
 */
export const BLOB_PARAMS = [
  { key: 'amp',   label: '幅度', def: 3.5, min: 0, max: 14, step: 0.1,  dec: 1, unit: '°' },
  { key: 'spd',   label: '速度', def: 1,   min: 0, max: 3,  step: 0.01, dec: 2, unit: '×' },
  // Lag is in cycles, the same unit the old head/leg "相位差" used, so it
  // survives the loop untouched and the GIF seam maths still applies.
  { key: 'delay', label: '滞后', def: 0,   min: 0, max: 1,  step: 0.01, dec: 2, unit: '' },
];

/** The subset a region also carries. A region lags through its ellipses. */
export const REGION_PARAMS = BLOB_PARAMS.filter(p => p.key !== 'delay');

const REGION_PARAM_KEYS = REGION_PARAMS.map(p => p.key);
const BLOB_PARAM_KEYS = BLOB_PARAMS.map(p => p.key);

/**
 * Every global slider, in panel order.
 *
 * The per-region amplitude and speed sliders are not here: their labels and
 * ranges come from REGION_PARAMS, but how many of them exist depends on how
 * many regions the project has, so the panel generates them from the region
 * list instead of from a fixed table.
 *
 * `scale` converts to what the slider shows, matching `BAKE_SCALE` in
 * tools/build_demo.py. Keeping one table means the panel, the saved project and
 * the baked demo can't disagree about a range.
 */
export const PARAMS = [
  { key: 'harm', label: '自然度', def: 0.22, min: 0, max: 0.6, step: 0.01, scale: 1, dec: 2, unit: '' },
  { key: 'zoom', label: '缩放',   def: 1,    min: 40, max: 130, step: 1,   scale: 0.01, dec: 0, unit: '%' },
];

/** Save order for `_params`, and the keys the exporter bakes into the sliders. */
export const PARAM_KEYS = PARAMS.map(p => p.key);

export function defaultParams() {
  const p = {};
  for (const s of PARAMS) p[s.key] = s.def;
  return p;
}

/** Clamp every known key to its range; anything missing or non-numeric keeps its default. */
export function sanitizeParams(raw) {
  const p = defaultParams();
  if (!raw) return p;
  for (const s of PARAMS) {
    const v = raw[s.key];
    if (typeof v === 'number' && isFinite(v)) p[s.key] = Math.min(s.max, Math.max(s.min, v));
  }
  return p;
}

/** A number if it is one and inside [lo, hi], otherwise `fallback`. */
function num(v, fallback, lo, hi) {
  return typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

const isPair = a => Array.isArray(a) && a.length >= 2 && isFinite(a[0]) && isFinite(a[1]);
const clampByte = v => Math.min(255, Math.max(0, Math.round(v)));
const isByteTriple = a => Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(v => typeof v === 'number' && isFinite(v));

/**
 * Coerce anything into a region list the shader can survive.
 *
 * Structural and forgiving on purpose. A malformed region does not throw where
 * it is loaded -- it throws inside regionW() mid-frame, on `for (const b of
 * reg.blobs)`, which surfaces to the user as a stage that quietly stopped
 * painting rather than as a rejected file. Anything unusable keeps its default
 * so a partly-corrupt project still opens.
 *
 * Accepts either the bare array or a whole regions.json, because both spellings
 * show up: the project stores the list, the file wraps it next to `_params`.
 */
export function normalizeRegions(raw) {
  const list = Array.isArray(raw) ? raw
    : raw && Array.isArray(raw.regions) ? raw.regions
    : null;
  if (!list) return defaultRegions();

  const out = [];
  for (const src of list) {
    if (!src || typeof src !== 'object') continue;
    const region = {
      name: typeof src.name === 'string' && src.name.trim()
        ? src.name.trim().slice(0, 24) : `部位 ${out.length + 1}`,
      pivot: isPair(src.pivot) ? [src.pivot[0], src.pivot[1]] : [0.5, 0.5],
      color: isByteTriple(src.color) ? src.color.slice(0, 3).map(clampByte) : [200, 200, 200],
      blobs: [],
    };
    // The region's own values are the inheritance source below, so fill them
    // first -- an ellipse that names no amplitude follows its region's.
    for (const p of REGION_PARAMS) region[p.key] = num(src[p.key], p.def, p.min, p.max);

    const blobs = Array.isArray(src.blobs) ? src.blobs : [];
    for (const b of blobs) {
      if (region.blobs.length >= MAX_BLOBS) break;
      if (!b || !isPair(b.c) || !isPair(b.r)) continue;
      const blob = { c: [b.c[0], b.c[1]], r: [b.r[0], b.r[1]], rot: num(b.rot, 0, -1e6, 1e6) };
      // `?? p.def` matters for lag: a region lags through its ellipses, so it
      // has no `delay` of its own to inherit from, and an ellipse written
      // without one would end up holding undefined. That reads as NaN in the
      // angle and as a blank field in the inspector rather than as an error.
      for (const p of BLOB_PARAMS) blob[p.key] = num(b[p.key], region[p.key] ?? p.def, p.min, p.max);
      region.blobs.push(blob);
    }
    out.push(region);
  }
  // An empty file is not a project; fall back rather than paint nothing.
  return out.length ? out : defaultRegions();
}

/** A region with no ellipses never moves -- legal, but the panel should say so. */
export function emptyRegions(regions) {
  return regions.filter(r => !r.blobs.length);
}

/**
 * Every ellipse, region by region and, within a region, in array order.
 *
 * The index here **is** the weight-texture channel, so this order is part of
 * the contract between regions.js, core/region_field.js and
 * core/region_field.py. The two fields are pinned together by
 * verify/test_weight_golden.js; what pins this function to the shader is only
 * that everyone means the same thing by "the order the user sees".
 *
 * `regs` is the region each ellipse belongs to, parallel to `blobs` -- kept in
 * one function rather than two so they cannot drift out of step.
 */
export function flatBlobs(regions) {
  const blobs = [], regs = [];
  for (const reg of regions) {
    for (const blob of reg.blobs) { blobs.push(blob); regs.push(reg); }
  }
  return { blobs, regs };
}

/** Project to exactly what the runtime reads, the way build_demo.py does. */
export function projectRegions(regions) {
  return regions.map(reg => {
    const out = { name: reg.name, pivot: reg.pivot, color: reg.color };
    for (const k of REGION_PARAM_KEYS) out[k] = reg[k];
    out.blobs = reg.blobs.map(b => {
      const blob = { c: b.c, r: b.r, rot: b.rot };
      for (const k of BLOB_PARAM_KEYS) blob[k] = b[k];
      return blob;
    });
    return out;
  });
}
