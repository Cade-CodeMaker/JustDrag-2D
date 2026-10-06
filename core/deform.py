"""The deformation math, in Python -- an oracle for the shader.

`displacement()` is the shared, load-bearing part: it is the same formula as
`core/deform.glsl`, and it is why rotating about a pivot placed at a joint
needs no extra feathering -- displacement is proportional to distance from the
pivot, so it goes to zero there on its own.

Sampling is deliberately NOT shared. `sample_bilinear()` here mirrors GLSL's
`texture2D` by hand and is what `tools/preview.py` needs; the verify/
diagnostics instead sample with `scipy.ndimage.map_coordinates`. Those two
samplers do not produce identical output, so unifying them would quietly change
what the diagnostics report.
"""
import numpy as np


def displacement(px, py, blob_weights, blob_pivots, blob_deg):
    """Per-pixel source offset, in normalized uv.

    `blob_weights`, `blob_pivots` and `blob_deg` are parallel sequences, one
    entry per ellipse, in the same channel order core/region_field.py
    rasterises into. Every ellipse in a region shares that region's pivot;
    only the angle differs, which is the whole point of the layout.

    Inverse mapping: for each *output* pixel, where should it read from? A
    forward (scatter) map would leave holes and overlaps; this direction gives
    every output pixel exactly one source, with no seams by construction.

    Summing the weighted offsets and dividing once -- rather than dividing each
    weight first, as the per-region version did -- is what core/deform.glsl
    does. It is the same number: the bake makes a region's channels sum to its
    coverage, so `total` here is the old `wh + wl`.
    """
    ox = np.zeros(px.shape, np.float32)
    oy = np.zeros(px.shape, np.float32)
    total = np.zeros(px.shape, np.float32)
    for w, (pvx, pvy), deg in zip(blob_weights, blob_pivots, blob_deg):
        th = np.radians(-deg)                 # inverse rotation
        ct, st = np.cos(th), np.sin(th)
        dx, dy = px - pvx, py - pvy
        ox += w * (pvx + (dx * ct - dy * st) - px)
        oy += w * (pvy + (dx * st + dy * ct) - py)
        total += w
    # keep the blend convex where regions overlap, so displacement cannot overshoot
    scale = np.where(total > 1.0, 1.0 / np.maximum(total, 1e-6), 1.0)
    return ox * scale, oy * scale


def baked_weights(wf):
    """A region's per-ellipse weights, scaled by `k = M / S` so they sum to `M`.

    This is the bake `core/region_field.py`'s rasterize() writes into the
    texture, reproduced analytically. Callers that give every ellipse its own
    angle (tools/preview.py) need the per-ellipse values; a caller that poses a
    whole region at once can go through region_pose() instead.
    """
    raw = wf["blobs"]
    M = wf["weight"]
    S = np.zeros_like(M)
    for w in raw:
        S = S + w
    k = np.zeros_like(M)
    np.divide(M, S, out=k, where=S > 0)
    return [w * k for w in raw]


def region_pose(regions, weights, deg_by_region):
    """Flatten a per-region pose into the parallel per-ellipse sequences
    `displacement()` takes.

    `weights` is `region_field.weight_field()`'s output and `deg_by_region` is
    one angle per region, in region order. Every ellipse in a region turns by
    its region's angle, because a region's ellipses share a pivot and it is the
    pivot that makes the motion coherent -- the layout gives ellipses their own
    amplitude and lag, not their own centre of rotation.

    **The bake has to be reproduced here.** The shader samples channels that
    were pre-scaled by `k_r = M_r / S_r`, so a region's channels *sum* to its
    coverage. Handing every ellipse the region's full coverage instead would
    sum to `n_r * M_r`: the numerator would be `n_r` times too large and, once
    `total` passes 1, so would the denominator -- leaving the displacement
    short by a factor of `n_r`. That is a silent under-report in every
    diagnostic, so the scaling happens here rather than being assumed.

    A caller that animates each ellipse separately (tools/preview.py does)
    builds the three sequences itself instead; this is for the diagnostics,
    which sweep one region's amplitude at a time.
    """
    ws, pivots, degs = [], [], []
    for reg, wf, deg in zip(regions, weights, deg_by_region):
        for w in baked_weights(wf):
            ws.append(w)
            pivots.append(tuple(reg["pivot"]))
            degs.append(deg)
    return ws, pivots, degs


def sample_bilinear(src, px, py, ox, oy):
    """GLSL `texture2D` by hand: bilinear, clamped at the edges."""
    h, w = src.shape[:2]
    u = (px + ox) * w - 0.5
    v = (py + oy) * h - 0.5
    x0 = np.clip(np.floor(u).astype(np.int32), 0, w - 1)
    y0 = np.clip(np.floor(v).astype(np.int32), 0, h - 1)
    x1 = np.clip(x0 + 1, 0, w - 1)
    y1 = np.clip(y0 + 1, 0, h - 1)
    fx = np.clip(u - x0, 0, 1)[..., None]
    fy = np.clip(v - y0, 0, 1)[..., None]
    return (src[y0, x0] * (1 - fx) * (1 - fy) + src[y0, x1] * fx * (1 - fy) +
            src[y1, x0] * (1 - fx) * fy + src[y1, x1] * fx * fy)
