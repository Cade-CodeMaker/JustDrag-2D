"""Is the edge bleed painting black into the margin instead of character colour?

    python -m verify.check_fringe <name> [--crop x,y] [--half N]

core/matting.bleed() keys the dilation on `alpha > 0`, but rembg leaves a ~2px
ring of near-black, barely-transparent pixels around the character. Those count
as "known", so the bleed propagates *their* colour outward -- and the cutout
writes the original alpha back, so the margin ends up black with alpha 0. A
bilinear sample straddling the silhouette then blends solid colour with black.

Renders the same crop through the real deform math, two ways:
  as shipped  /  re-bled from alpha>0.5 only

`bleed_from` below is deliberately NOT core.matting.bleed(). Its entire value is
being an independent reimplementation to compare against; importing the real one
would make the diagnostic circular and prove nothing.
"""
import argparse

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

from core import deform, paths, region_field

AMPS = ((3.5, 4.55), (7, 9.1))
ZOOM = 6
LABEL_H = 24


def bleed_from(rgba, seed, passes=8):
    """Push `seed` pixels' colour outward, leaving alpha untouched."""
    rgb = rgba[..., :3].astype(np.float32).copy()
    known = seed.copy()
    for _ in range(passes):
        acc = np.zeros_like(rgb)
        cnt = np.zeros(known.shape, np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                sr = np.roll(np.roll(rgb, dy, 0), dx, 1)
                sk = np.roll(np.roll(known, dy, 0), dx, 1).astype(np.float32)
                acc += sr * sk[..., None]
                cnt += sk
        grow = (~known) & (cnt > 0)
        if not grow.any():
            break
        rgb[grow] = acc[grow] / cnt[grow][:, None]
        known = known | grow
    out = rgba.copy()
    out[..., :3] = np.clip(rgb, 0, 255)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("name", nargs="?",
                    help="asset name; optional while only one asset exists")
    ap.add_argument("--model", help="cutout variant (only needed if several exist)")
    ap.add_argument("--crop", help="x,y in normalized coords; default: the worst pixel")
    ap.add_argument("--half", type=int, default=70, help="crop half-size, px (default: %(default)s)")
    args = ap.parse_args()

    a = paths.resolve(args.name)
    regions = region_field.load_regions(a.regions_json)
    raw = np.asarray(Image.open(a.character_png(args.model)).convert("RGBA")).astype(np.float32)
    alpha = raw[..., 3] / 255.0
    h, w = alpha.shape

    yy, xx = np.mgrid[0:h, 0:w]
    px = ((xx + 0.5) / w).astype(np.float32)
    py = ((yy + 0.5) / h).astype(np.float32)
    weights = region_field.weight_field(regions, px, py)

    def displacement(head_deg, leg_deg):
        # Region 0 takes the first angle, the rest take the second -- see the
        # matching note in verify/check_bleed.py.
        return deform.displacement(px, py, *deform.region_pose(
            regions, weights, [head_deg] + [leg_deg] * (len(regions) - 1)))

    def render(rgba, head_deg, leg_deg, bg=(0.42, 0.42, 0.44)):
        """Same composite as the shader: mix(bg, col.rgb, col.a)."""
        ox, oy = displacement(head_deg, leg_deg)
        coords = [np.clip((py + oy) * h - 0.5, 0, h - 1),
                  np.clip((px + ox) * w - 0.5, 0, w - 1)]
        al = ndimage.map_coordinates(rgba[..., 3] / 255.0, coords, order=1, mode="nearest")
        out = np.empty((h, w, 3), np.float32)
        for c in range(3):
            ch = ndimage.map_coordinates(rgba[..., c] / 255.0, coords, order=1, mode="nearest")
            out[..., c] = ch * al + bg[c] * (1 - al)
        return out

    solid = raw[..., 3] > 127
    panels = [("as shipped (bled from a>0)", raw),
              ("re-bled from a>0.5", bleed_from(raw, solid))]

    if args.crop:
        cx, cy = (float(v) for v in args.crop.split(","))
    else:
        # auto: the pixel that moves furthest, so the crop lands on the real seam
        mag_ox, mag_oy = displacement(*AMPS[-1])
        mag = np.hypot(mag_ox * w, mag_oy * h)
        cy_i, cx_i = np.unravel_index(np.argmax(mag), mag.shape)
        cx, cy = (cx_i + 0.5) / w, (cy_i + 0.5) / h

    half = args.half
    x0, y0 = int(cx * w) - half, int(cy * h) - half
    cell = 2 * half * ZOOM

    rows = [("undeformed", (0, 0))] + [(f"{hd:g}deg", (hd, ld)) for hd, ld in AMPS]
    strip = Image.new("RGB", (cell * len(panels) + 10, (cell + LABEL_H) * len(rows)), (24, 24, 28))
    draw = ImageDraw.Draw(strip)
    for ri, (row_label, (head_deg, leg_deg)) in enumerate(rows):
        for ci, (panel_label, arr) in enumerate(panels):
            crop = np.clip(render(arr, head_deg, leg_deg)[y0:y0 + 2 * half, x0:x0 + 2 * half], 0, 1)
            im = Image.fromarray((crop * 255).astype(np.uint8)).resize((cell, cell), Image.NEAREST)
            ox_, oy_ = ci * (cell + 5), ri * (cell + LABEL_H) + 22
            strip.paste(im, (ox_, oy_))
            if ri == 0:
                draw.text((ox_ + 6, 6), panel_label, fill=(255, 240, 120))
            if ci == 0:
                draw.text((6, oy_ - 16), row_label, fill=(150, 220, 255))
    out = a.out("fringe_compare.png")
    strip.save(out)
    print(f"wrote {out}  (crop ({cx:.2f},{cy:.2f}))")

    # how dark is the margin, numerically?
    for label, arr in panels:
        m = (arr[..., 3] > 0) & (arr[..., 3] <= 128)
        if m.sum():
            print(f"  {label:32s} margin mean RGB {arr[m][:, :3].mean(axis=0).round(1)}"
                  f"  ({int(m.sum())} px)")


if __name__ == "__main__":
    main()
