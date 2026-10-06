"""Offline reference renderer for the deformation shader.

    python -m tools.preview <name> [--model isnet-anime]

Runs the same math as the shader, in Python, so the motion can be eyeballed
with no GPU and no browser -- tune an ellipse, run again, look. It doubles as
the oracle the golden test measures the browser against, which is why
`core/deform.py` and `core/deform.glsl` are kept line-for-line equivalent.

The animation is per ellipse, not per region: each one reads its own amp, spd
and delay, so two ellipses in one region can be out of step. That makes this
the one place outside the browser where the resulting motion can be seen at
all, which is most of why it exists.

Writes a contact sheet over one animation cycle, plus a weight-map view.
"""
import argparse

import numpy as np
from PIL import Image, ImageDraw

from core import deform as deform_math
from core import paths, region_field

# The "naturalness" slider: mixes in a second harmonic so the swing is not a
# pure sine. Mirrors the default of `harm` in app/src/regions.js.
HARM = 0.22

N = 6         # frames in the contact sheet
CELL = 340
WEIGHT_PX = 560
TILE = 16     # checker square, px


def swing(amp, spd, delay, harm, t):
    """One ellipse's angle in degrees at time `t`, in cycles.

    Mirrors `swing()` in app/src/pose.js, which is the copy that actually
    drives what ships. Dividing by (1 + harm) keeps the peak amplitude at
    `amp` whatever the harmonic, so the slider changes the shape of the swing
    without changing how far it swings.
    """
    u = 2 * np.pi * (t * spd + delay)
    return amp * (np.sin(u) + harm * np.sin(2 * u)) / (1 + harm)


def blob_angle(reg, b, t):
    """One ellipse's angle, taking its region's values as the inheritance default.

    A hand-written regions.json may leave amp/spd/delay off an ellipse; the JS
    side fills those in from the region, so this does too rather than reading
    None into the arithmetic.
    """
    return swing(b.get("amp", reg.get("amp", 0.0)),
                 b.get("spd", reg.get("spd", 1.0)),
                 b.get("delay", 0.0), HARM, t)


def checker(yy, xx, lo=88, hi=132):
    """A neutral checkerboard, as float RGB, for compositing RGBA onto."""
    return np.where((((yy // TILE + xx // TILE) % 2) == 0)[..., None], lo, hi) \
             .repeat(3, axis=2) / 255.0


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("name", nargs="?",
                    help="asset name; optional while only one asset exists")
    ap.add_argument("--model", help="cutout variant (only needed if several exist)")
    args = ap.parse_args()

    a = paths.resolve(args.name)
    img = Image.open(a.character_png(args.model)).convert("RGBA")
    w, h = img.size
    src = np.asarray(img).astype(np.float32) / 255.0
    regions = region_field.load_regions(a.regions_json)

    yy, xx = np.mgrid[0:h, 0:w]
    px = ((xx + 0.5) / w).astype(np.float32)
    py = ((yy + 0.5) / h).astype(np.float32)

    weights = region_field.weight_field(regions, px, py)
    print("coverage: " + "  ".join(
        f"{wf['name'] or i}={wf['weight'].mean():.1%}"
        for i, wf in enumerate(weights)))

    def render(t):
        """Inverse-map every output pixel back to its source, then sample.

        Each ellipse brings its own angle here, so this builds the parallel
        sequences itself instead of going through `region_pose` -- but it still
        has to apply the same `M/S` bake, or a region's ellipses would together
        outweigh the region itself.
        """
        ws, pivots, degs = [], [], []
        for reg, wf in zip(regions, weights):
            for b, w in zip(reg["blobs"], deform_math.baked_weights(wf)):
                ws.append(w)
                pivots.append(tuple(reg["pivot"]))
                degs.append(blob_angle(reg, b, t))
        ox, oy = deform_math.displacement(px, py, ws, pivots, degs)
        return deform_math.sample_bilinear(src, px, py, ox, oy), degs

    def on_checker(rgba):
        alpha = rgba[..., 3:]
        return rgba[..., :3] * alpha + checker(yy, xx) * (1 - alpha)

    # --- contact sheet across one cycle ---
    sheet = Image.new("RGB", (CELL * 3, CELL * 2), (24, 24, 28))
    draw = ImageDraw.Draw(sheet)
    for i in range(N):
        t = i / N
        rgb, degs = render(t)
        tile = Image.fromarray((np.clip(on_checker(rgb), 0, 1) * 255).astype(np.uint8)) \
                    .resize((CELL, CELL), Image.LANCZOS)
        ox_, oy_ = (i % 3) * CELL, (i // 3) * CELL
        sheet.paste(tile, (ox_, oy_))
        # Every ellipse has its own angle now, so a per-region readout would be
        # a lie as soon as two of them are given different lags. Show the range
        # across all of them instead: one number when they agree, two when they
        # do not, which is exactly the case worth seeing.
        draw.text((ox_ + 10, oy_ + 10),
                  f"t={t:.2f}  angles {min(degs):+.1f}..{max(degs):+.1f}d",
                  fill=(255, 240, 120))
    out = a.out("anim_sheet.png")
    sheet.save(out)
    print(f"wrote {out}")

    # --- weight map view ---
    wm = np.zeros((h, w, 3), np.float32)
    hottest = np.zeros((h, w), np.float32)
    for wf in weights:
        wm += np.array(wf["color"], np.float32) / 255.0 * wf["weight"][..., None] * 0.75
        hottest = np.maximum(hottest, wf["weight"])
    over = np.clip(on_checker(src) * (1 - 0.6 * hottest[..., None]) + wm, 0, 1)
    out = a.out("anim_weights.png")
    Image.fromarray((over * 255).astype(np.uint8)).resize((WEIGHT_PX, WEIGHT_PX),
                                                          Image.LANCZOS).save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
