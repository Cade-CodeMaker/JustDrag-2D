"""Matting: rembg cutout, then the edge bleed.

`bleed()` is standalone and numpy-only (DESIGN.md 6.1), so it can be reused and
tested without rembg or onnxruntime loaded.
"""
import numpy as np
from PIL import Image

BLEED = 8   # px of colour dilation into the transparent margin

_NEIGHBOURS = ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1))


def cutout(src, model="isnet-anime"):
    """RGBA cutout of `src` using the named rembg model (weights download once)."""
    from rembg import remove, new_session

    session = new_session(model)
    return remove(Image.open(src).convert("RGB"), session=session).convert("RGBA")


def bleed(rgb, alpha, px=BLEED):
    """Push interior colour outward into the transparent margin.

    Without this the shader tears black notches along the contour: deforming
    rotates the source, so the inverse map samples *outside* the silhouette,
    where the pixels are transparent and their RGB is garbage.

    Note the seed is `alpha > 0`, which includes rembg's ~2px ring of
    near-black, barely-transparent pixels -- so that colour is what gets pushed
    out. `verify/check_fringe.py` exists precisely to measure this and compares
    it against seeding on `alpha > 0.5`. The behaviour is kept as-is on purpose:
    changing the seed changes the shipped cutout, which is a separate decision.

    Returns the widened colour only -- alpha is not this function's business.
    Callers write the *original* alpha alongside it; the mask grown here exists
    solely to track how far the colour has spread, and leaking it into the saved
    cutout would silently erase the character's soft edge.
    """
    rgb = rgb.astype(np.float32)            # copy: this mutates as it grows
    a8 = (alpha * 255).astype(np.uint8)
    for _ in range(px):
        known = a8 > 0
        if known.all():
            break
        acc = np.zeros_like(rgb, dtype=np.float64)
        cnt = np.zeros(a8.shape, dtype=np.float64)
        for dy, dx in _NEIGHBOURS:
            sh_rgb = np.roll(np.roll(rgb, dy, axis=0), dx, axis=1)
            sh_k = np.roll(np.roll(known, dy, axis=0), dx, axis=1).astype(np.float64)
            acc += sh_rgb * sh_k[..., None]
            cnt += sh_k
        grow = (~known) & (cnt > 0)
        if not grow.any():
            break
        rgb[grow] = acc[grow] / cnt[grow][:, None]
        a8[grow] = 1
    return rgb
