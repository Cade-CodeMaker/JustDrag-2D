"""Is the edge bleed wide enough at every amplitude the slider allows?

    python -m verify.check_bleed <name> [--crop x,y] [--half N]

The naive check ("a solid pixel samples transparent => tear") is WRONG: at the
trailing edge of a moving part the silhouette is *supposed* to vacate, so
sampling transparent there is correct. The only genuine defect is a hole
enclosed by solid pixels -- a correct inverse map can never produce one.

So: deform the alpha, fill holes, and see whether any hole appears that was not
already there in the undeformed cutout.

The sampler here is scipy's, deliberately different from the hand-rolled
bilinear in core/deform.py that tools/preview.py uses to mirror GLSL. Only the
displacement field is shared.
"""
import argparse

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

from core import deform, matting, paths, region_field

AMP_STEPS = (3.5, 5, 7, 9, 11, 14)
REACH_STEPS = (3.5, 14)
PANELS = (("undeformed", (0, 0)), ("3.5 deg", (3.5, 4.55)), ("7 deg", (7, 9.1)))
ZOOM = 8
LABEL_H = 26


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
    src = np.asarray(Image.open(a.character_png(args.model)).convert("RGBA")).astype(np.float32) / 255.0
    alpha = src[..., 3]
    h, w = alpha.shape
    bleed = matting.BLEED

    yy, xx = np.mgrid[0:h, 0:w]
    px = ((xx + 0.5) / w).astype(np.float32)
    py = ((yy + 0.5) / h).astype(np.float32)
    weights = region_field.weight_field(regions, px, py)

    def sample(field, ox, oy):
        """Bilinear sample of `field` at (px+ox, py+oy) in normalized coords."""
        u = np.clip((px + ox) * w - 0.5, 0, w - 1)
        v = np.clip((py + oy) * h - 0.5, 0, h - 1)
        return ndimage.map_coordinates(field, [v, u], order=1, mode="nearest")

    def deform_alpha(head_deg, leg_deg):
        # The sweep is over "the head" and "everything else": region 0 takes the
        # first angle, the rest take the second. Only the pose matters here, not
        # which region is which -- this measures holes, and holes come from how
        # far something moved, not from what it was called.
        pose = deform.region_pose(regions, weights,
                                  [head_deg] + [leg_deg] * (len(regions) - 1))
        ox, oy = deform.displacement(px, py, *pose)
        return sample(alpha, ox, oy), np.hypot(ox * w, oy * h)

    def holes_of(a_):
        solid = a_ > 0.5
        return ndimage.binary_fill_holes(solid) & ~solid

    base = holes_of(alpha)
    solid_px = int((alpha > 0.5).sum())
    print(f"{a.name}: {w}x{h}, bleed={bleed}px, solid {np.mean(alpha > 0.5):.1%}")
    print(f"holes already present in the undeformed cutout: {int(base.sum())} px "
          f"({base.sum() / solid_px * 100:.3f}% of solid)")
    print()
    print(f"{'amplitude':>10} {'max|disp|':>10} {'new holes':>10} {'% of solid':>11}   where")
    print("-" * 74)

    for amp in AMP_STEPS:
        a_def, mag = deform_alpha(amp, amp * 1.3)
        new = holes_of(a_def) & ~base
        n = int(new.sum())
        pct = n / solid_px * 100
        if n:
            ys, xs = np.nonzero(new)
            far = np.argmax(mag[ys, xs])
            where = f"({xs[far] / w:.2f}, {ys[far] / h:.2f})  at {mag[ys[far], xs[far]]:.0f}px disp"
        else:
            where = "-"
        print(f"{amp:>8.1f}d {mag.max():>10.1f} {n:>10d} {pct:>10.3f}%   {where}")

    print()
    print("Also: how far past the silhouette does the inverse map reach, worst case?")
    for amp in REACH_STEPS:
        _, mag = deform_alpha(amp, amp * 1.3)
        out = mag > 0
        print(f"  {amp:>4.1f}deg  p99.9 displacement {np.percentile(mag[out], 99.9):5.1f}px"
              f"   (bleed is {bleed}px)")

    # --- can you actually see it? crop the worst spot, magnified, on a checker ground ---
    if args.crop:
        cx, cy = (float(v) for v in args.crop.split(","))
    else:
        # auto: the pixel that moves furthest at the largest amplitude tested
        _, mag = deform_alpha(AMP_STEPS[-1], AMP_STEPS[-1] * 1.3)
        cy_i, cx_i = np.unravel_index(np.argmax(mag), mag.shape)
        cx, cy = (cx_i + 0.5) / w, (cy_i + 0.5) / h

    half = args.half
    x0, y0 = int(cx * w) - half, int(cy * h) - half

    def on_checker(a_):
        ck = np.repeat(np.where(((yy // 16 + xx // 16) % 2) == 0, 88, 132)[..., None] / 255.0, 3, 2)
        return src[..., :3] * a_[..., None] + ck * (1 - a_[..., None])

    panels = []
    for label, (hd, ld) in PANELS:
        a_def = alpha if not hd else deform_alpha(hd, ld)[0]
        crop = np.clip(on_checker(a_def)[y0:y0 + 2 * half, x0:x0 + 2 * half], 0, 1)
        panels.append((label, Image.fromarray((crop * 255).astype(np.uint8))
                       .resize((2 * half * ZOOM, 2 * half * ZOOM), Image.NEAREST)))

    strip = Image.new("RGB", (sum(p.width for _, p in panels) + 20, panels[0][1].height + LABEL_H),
                      (24, 24, 28))
    draw = ImageDraw.Draw(strip)
    ox_ = 0
    for label, im in panels:
        strip.paste(im, (ox_, LABEL_H))
        draw.text((ox_ + 8, 8), label, fill=(255, 240, 120))
        ox_ += im.width + 10
    out = a.out("bleed_crop.png")
    strip.save(out)
    print(f"\nwrote {out}  (worst spot ({cx:.2f},{cy:.2f}), {ZOOM}x, bleed={bleed}px)")


if __name__ == "__main__":
    main()
