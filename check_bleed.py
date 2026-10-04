"""Throwaway diagnostic: is the 8px edge bleed enough at every amplitude the
slider allows?

The naive check ("solid pixel samples transparent => tear") is WRONG: at the
trailing edge of a moving part the silhouette is *supposed* to vacate, so
sampling transparent there is correct.  The only genuine defect is a hole
enclosed by solid pixels -- a correct inverse map can never produce one.

So: deform the alpha, fill holes, and see whether any hole appears that was not
already there in the undeformed cutout.

    D:\\coding\\conda\\envs\\art\\python.exe check_bleed.py
"""
import json
import pathlib
import numpy as np
from PIL import Image
from scipy import ndimage

pathlib.Path("build").mkdir(parents=True, exist_ok=True)

CUT = "build/character_isnet-anime.png"
INNER, OUTER = 0.75, 1.35
BLEED = 8

src = np.asarray(Image.open(CUT).convert("RGBA")).astype(np.float32) / 255.0
alpha = src[..., 3]
H, W = alpha.shape

yy, xx = np.mgrid[0:H, 0:W]
px = ((xx + 0.5) / W).astype(np.float32)
py = ((yy + 0.5) / H).astype(np.float32)

REGIONS = {k: v for k, v in json.load(open("regions.json", encoding="utf-8")).items()
           if not k.startswith("_")}


def blob_weight(ux, uy, blobs):
    w = np.zeros(ux.shape, np.float32)
    for b in blobs:
        cx, cy = b["c"]; rx, ry = b["r"]; th = np.radians(b["rot"])
        dx, dy = ux - cx, uy - cy
        u = dx * np.cos(th) + dy * np.sin(th)
        v = -dx * np.sin(th) + dy * np.cos(th)
        d = np.sqrt((u / rx) ** 2 + (v / ry) ** 2)
        w = np.maximum(w, np.clip(1.0 - (d - INNER) / (OUTER - INNER), 0.0, 1.0))
    return w


weights = {k: blob_weight(px, py, v["blobs"]) for k, v in REGIONS.items()}


def sample(field, ox, oy):
    """Bilinear sample of `field` at (px+ox, py+oy) in normalized coords."""
    u = np.clip((px + ox) * W - 0.5, 0, W - 1)
    v = np.clip((py + oy) * H - 0.5, 0, H - 1)
    return ndimage.map_coordinates(field, [v, u], order=1, mode="nearest")


def deform_alpha(hd, ld):
    ox = np.zeros((H, W), np.float32)
    oy = np.zeros((H, W), np.float32)
    total = np.zeros((H, W), np.float32)
    for key, deg in (("head", hd), ("legs", ld)):
        pxx, pyy = REGIONS[key]["pivot"]
        th = np.radians(-deg)
        ct, st = np.cos(th), np.sin(th)
        dx, dy = px - pxx, py - pyy
        ox += weights[key] * (pxx + (dx * ct - dy * st) - px)
        oy += weights[key] * (pyy + (dx * st + dy * ct) - py)
        total += weights[key]
    s = np.where(total > 1.0, 1.0 / np.maximum(total, 1e-6), 1.0)
    return sample(alpha, ox * s, oy * s), np.hypot(ox * s * W, oy * s * H)


def holes_of(a):
    solid = a > 0.5
    return ndimage.binary_fill_holes(solid) & ~solid


base = holes_of(alpha)
print(f"cutout {W}x{H}, bleed={BLEED}px, solid {np.mean(alpha > 0.5):.1%}")
print(f"holes already present in the undeformed cutout: {int(base.sum())} px "
      f"({base.sum() / (alpha > 0.5).sum() * 100:.3f}% of solid)")
print()
print(f"{'amplitude':>10} {'max|disp|':>10} {'new holes':>10} {'% of solid':>11}   where")
print("-" * 74)

for amp in (3.5, 5, 7, 9, 11, 14):
    a, mag = deform_alpha(amp, amp * 1.3)
    new = holes_of(a) & ~base
    n = int(new.sum())
    pct = n / (alpha > 0.5).sum() * 100
    if n:
        ys, xs = np.nonzero(new)
        far = np.argmax(mag[ys, xs])
        where = f"({xs[far] / W:.2f}, {ys[far] / H:.2f})  at {mag[ys[far], xs[far]]:.0f}px disp"
    else:
        where = "-"
    print(f"{amp:>8.1f}d {mag.max():>10.1f} {n:>10d} {pct:>10.3f}%   {where}")

print()
print("Also: how far past the silhouette does the inverse map reach, worst case?")
for amp in (3.5, 14):
    a, mag = deform_alpha(amp, amp * 1.3)
    out = mag > 0
    reach = np.percentile(mag[out], 99.9)
    print(f"  {amp:>4.1f}deg  p99.9 displacement {reach:5.1f}px   (bleed is {BLEED}px)")


# --- can you actually see it?  crop the worst spot, 3x, on a checker ground ---
def on_checker(a):
    ck = np.repeat(np.where(((yy // 16 + xx // 16) % 2) == 0, 88, 132)[..., None] / 255.0, 3, 2)
    return src[..., :3] * a[..., None] + ck * (1 - a[..., None])


cx, cy, half, zoom = 0.63, 0.29, 70, 8
x0, y0 = int(cx * W) - half, int(cy * H) - half
panels = []
for label, (hd, ld) in (("undeformed", (0, 0)), ("3.5 deg", (3.5, 4.55)), ("7 deg", (7, 9.1))):
    a, _ = deform_alpha(hd, ld) if hd else (alpha, None)
    crop = np.clip(on_checker(a)[y0:y0 + 2 * half, x0:x0 + 2 * half], 0, 1)
    im = Image.fromarray((crop * 255).astype(np.uint8)).resize(
        (2 * half * zoom, 2 * half * zoom), Image.NEAREST)
    panels.append((label, im))

strip = Image.new("RGB", (sum(p.width for _, p in panels) + 20, panels[0][1].height + 26), (24, 24, 28))
from PIL import ImageDraw
d = ImageDraw.Draw(strip)
ox = 0
for label, im in panels:
    strip.paste(im, (ox, 26))
    d.text((ox + 8, 8), label, fill=(255, 240, 120))
    ox += im.width + 10
strip.save("build/bleed_crop.png")
print(f"wrote build/bleed_crop.png  (worst spot ({cx},{cy}), {zoom}x, bleed={BLEED}px)")
