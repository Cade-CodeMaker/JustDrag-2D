"""The soft-ellipse weight field, in Python.

A region is the union of rotated soft ellipses ("blobs"): weight 1.0 inside
`INNER` radii, falling linearly to 0.0 at `OUTER` radii, taking the max over
blobs. Because the field is continuous there is no cut line anywhere -- which
is the whole reason this approach suits art whose braid and ribbon span the
entire body (DESIGN.md 3.3).

The texture carries **one channel per ellipse**, not one per region, so two
ellipses inside one region can swing out of step. That gives up the property
the old layout had for free -- that a region's channel was exactly its coverage
-- so `rasterize` restores it arithmetically, scaling each channel by
`k_r = M_r / S_r` so the region's channels sum back to what its single channel
used to be. See DESIGN for the derivation and for the quantisation bound.

Python port of `core/region_field.js`; `verify/test_weight_golden.js` (driven
against `verify/dump_weights.py`) asserts the two agree.

**Everything here is float64 on purpose.** The JS side runs on doubles, and the
bake multiplies before it truncates, so a float32 port would push a large
number of pixels across a truncation boundary by one LSB -- enough to blow the
golden test's difference budget for reasons that have nothing to do with a real
divergence. Sums are accumulated sequentially in blob order for the same
reason: `np.sum` reassociates, doubles do not.
"""
import json
import math
import pathlib

import numpy as np

INNER, OUTER = 0.75, 1.35   # blob falloff band, in multiples of the radius


def load_regions(path):
    """Load the ordered region list from regions.json.

    Drops the "_"-prefixed metadata keys, including `_params` (see
    load_params/load_meta). An ordered list, not a dict keyed by name: region
    names are user-editable and may repeat, so the order in the file is the
    only thing that identifies a region.

    Float values are preserved exactly as parsed: build_demo.py json.dumps()es
    these raw values straight into demo.html, so coercing or re-serialising
    anything here changes the built bytes.
    """
    raw = json.loads(pathlib.Path(path).read_text("utf-8"))
    if isinstance(raw, list):
        return raw
    return raw.get("regions") or []


def load_params(path):
    """The optional `_params` block: slider values to bake in as build defaults."""
    raw = json.loads(pathlib.Path(path).read_text("utf-8"))
    return raw.get("_params") or {}


def load_meta(path):
    """The "_"-prefixed keys except `_params`, in file order.

    load_regions() drops these, so the browser never sees them -- but the demo's
    save button rewrites the entire file, so it needs them baked in or a
    hand-written `_comment` would be silently destroyed by the first save.
    """
    raw = json.loads(pathlib.Path(path).read_text("utf-8"))
    return {k: v for k, v in raw.items() if k.startswith("_") and k != "_params"}


def texture_count(n):
    """RGBA textures needed to hold `n` ellipses. At least one, mirroring the JS."""
    return max(1, math.ceil(n / 4))


def shader_defines(n_blob):
    """The `#define` block that specialises core/deform.glsl for this count.

    Mirrors `shaderDefines()` in core/region_field.js -- both consumers of the
    shader prepend this rather than the build inlining a variant, which is why
    there is only ever one copy of deform.glsl on disk.
    """
    n = max(1, int(n_blob))
    return f"#define N_WTEX {texture_count(n)}\n#define N_BLOB {n}\n"


def single_blob_weight(uv_x, uv_y, b):
    """One ellipse's own weight at the given sample points."""
    cx, cy = b["c"]
    rx, ry = b["r"]
    # A degenerate ellipse has to contribute nothing rather than NaN. Its own
    # channel would be the only casualty in the old layout, but the bake sums
    # the region's weights to get k, so a NaN here would zero every channel in
    # the region and silently freeze the whole body part.
    if not (rx > 0) or not (ry > 0):    # also catches NaN
        return np.zeros(uv_x.shape, np.float64)

    th = np.radians(b["rot"])
    dx, dy = uv_x - cx, uv_y - cy
    u = dx * np.cos(th) + dy * np.sin(th)
    v = -dx * np.sin(th) + dy * np.cos(th)
    d = np.sqrt((u / rx) ** 2 + (v / ry) ** 2)
    return np.clip(1.0 - (d - INNER) / (OUTER - INNER), 0.0, 1.0)


def blob_weight(uv_x, uv_y, blobs):
    """A region's coverage: the max over its ellipses. `uv_*` are normalized coords."""
    w = np.zeros(uv_x.shape, np.float64)
    for b in blobs:
        w = np.maximum(w, single_blob_weight(uv_x, uv_y, b))
    return w


def weight_field(regions, uv_x, uv_y):
    """A list of `{name, color, weight, blobs}` in channel order.

    `weight` is the region's coverage `M` (the max over its ellipses) and
    `blobs` is one weight per ellipse, pre-bake. Both are here because the two
    consumers want different things: the weight-map view wants `M`, and
    `deform.region_pose` needs the per-ellipse values to reproduce the bake.

    A list rather than a dict keyed by name: names are user-editable and may
    repeat, and the channel order is the contract with the shader.
    """
    return [{"name": r.get("name"), "color": r.get("color"),
             "weight": blob_weight(uv_x, uv_y, r["blobs"]),
             "blobs": [single_blob_weight(uv_x, uv_y, b) for b in r["blobs"]]}
            for r in regions]


def rasterize(regions, size=256):
    """Rasterise the field to the RGBA textures the shader samples.

    Layout: four channels per texture, textures back to back, channel `c` at
    component `c % 4` of texture `floor(c / 4)` -- `texture_count(n)` textures,
    `size * size * 4` bytes each. Mirrors `rasterize()` in
    core/region_field.js sample-for-sample, including the quantisation, so the
    two can be hashed against each other.

    A texture rather than in-shader ellipses: the shader stays a handful of
    lines, and hand-painted masks can replace this later without touching it.
    """
    i = np.arange(size, dtype=np.float64) + 0.5
    uv = i / size
    uv_x, uv_y = np.meshgrid(uv, uv)          # uv_x varies along x, uv_y along y

    spans, total = [], 0
    for reg in regions:
        blobs = reg["blobs"]
        spans.append((blobs, total, len(blobs)))
        total += len(blobs)

    out = np.zeros((texture_count(total), size, size, 4), np.uint8)
    for blobs, lo, n in spans:
        if not n:
            continue
        ws = [single_blob_weight(uv_x, uv_y, b) for b in blobs]

        # Sequential, in blob order, exactly as the JS accumulates.
        S = np.zeros(uv_x.shape, np.float64)
        for w in ws:
            S = S + w
        M = np.zeros(uv_x.shape, np.float64)
        for w in ws:
            M = np.maximum(M, w)

        # k = M / S where S > 0, else 0. Computing M/S unconditionally would
        # divide by zero on the (common) empty pixels and warn on every run.
        k = np.zeros(uv_x.shape, np.float64)
        np.divide(M, S, out=k, where=S > 0)

        for b, w in enumerate(ws):
            t, comp = divmod(lo + b, 4)
            out[t, ..., comp] = ((255.0 * w) * k).astype(np.uint8)
    return out
