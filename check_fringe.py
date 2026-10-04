"""Is the edge bleed painting black into the margin instead of character colour?

build_cutout.py keys the dilation on `a8 > 0`, but rembg leaves a ~2px ring of
near-black, barely-transparent pixels around the character.  Those count as
"known", so the bleed propagates *their* colour outward -- and the output writes
the original alpha, so the margin ends up black with alpha 0.  A bilinear sample
straddling the silhouette then blends solid colour with black.

Renders the same 8x crop through the real deform math, three ways:
  as shipped  /  re-bled from alpha>0.5 only  /  margin zeroed (current behaviour, explicit)

    D:\\coding\\conda\\envs\\art\\python.exe check_fringe.py
"""
import json
import pathlib
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

pathlib.Path("build").mkdir(parents=True, exist_ok=True)

INNER, OUTER = 0.75, 1.35
SHEET = "build/character_isnet-anime.png"

raw = np.asarray(Image.open(SHEET).convert("RGBA")).astype(np.float32)
alpha = raw[..., 3] / 255.0
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


def displacement(hd, ld):
    ox = np.zeros((H, W), np.float32); oy = np.zeros((H, W), np.float32)
    total = np.zeros((H, W), np.float32)
    for key, deg in (("head", hd), ("legs", ld)):
        pxx, pyy = REGIONS[key]["pivot"]
        th = np.radians(-deg); ct, st = np.cos(th), np.sin(th)
        dx, dy = px - pxx, py - pyy
        ox += weights[key] * (pxx + (dx * ct - dy * st) - px)
        oy += weights[key] * (pyy + (dx * st + dy * ct) - py)
        total += weights[key]
    s = np.where(total > 1.0, 1.0 / np.maximum(total, 1e-6), 1.0)
    return ox * s, oy * s


def render(rgba, hd, ld, bg=(0.42, 0.42, 0.44)):
    """Same composite as the shader: mix(bg, col.rgb, col.a)."""
    ox, oy = displacement(hd, ld)
    coords = [np.clip((py + oy) * H - 0.5, 0, H - 1), np.clip((px + ox) * W - 0.5, 0, W - 1)]
    a = ndimage.map_coordinates(rgba[..., 3] / 255.0, coords, order=1, mode="nearest")
    out = np.empty((H, W, 3), np.float32)
    for c in range(3):
        ch = ndimage.map_coordinates(rgba[..., c] / 255.0, coords, order=1, mode="nearest")
        out[..., c] = ch * a + bg[c] * (1 - a)
    return out


def bleed_from(rgba, seed, passes=8):
    """Push `seed` pixels' colour outward, leaving alpha untouched."""
    rgb = rgba[..., :3].astype(np.float32).copy()
    known = seed.copy()
    for _ in range(passes):
        acc = np.zeros_like(rgb); cnt = np.zeros(known.shape, np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                sr = np.roll(np.roll(rgb, dy, 0), dx, 1)
                sk = np.roll(np.roll(known, dy, 0), dx, 1).astype(np.float32)
                acc += sr * sk[..., None]; cnt += sk
        grow = (~known) & (cnt > 0)
        if not grow.any():
            break
        rgb[grow] = acc[grow] / cnt[grow][:, None]
        known = known | grow
    out = rgba.copy(); out[..., :3] = np.clip(rgb, 0, 255)
    return out


solid = raw[..., 3] > 127
fixed = bleed_from(raw, solid)          # correct seed: real character pixels
halo = bleed_from(raw, raw[..., 3] > 0)  # what build_cutout.py effectively does

AMPS = [(3.5, 4.55), (7, 9.1)]
cx, cy, half, zoom = 0.63, 0.29, 70, 6

x0, y0 = int(cx * W) - half, int(cy * H) - half
panels = [("as shipped (bled from a>0)", raw), ("re-bled from a>0.5", fixed)]
for hd, ld in AMPS:
    for label, arr in panels:
        r = render(arr, hd, ld)
        crop = np.clip(r[y0:y0 + 2 * half, x0:x0 + 2 * half], 0, 1)
        pass

# lay out: row 1 = undeformed reference, row 2 = 3.5deg, row 3 = 7deg
rows = []
for hd, ld in [(0, 0)] + AMPS:
    rows.append([(f"{lbl}  {hd:g}deg" if hd else "undeformed", render(a, hd, ld)) for lbl, a in panels])

cell = 2 * half * zoom
strip = Image.new("RGB", (cell * len(panels) + 10, (cell + 24) * len(rows)), (24, 24, 28))
d = ImageDraw.Draw(strip)
for ri, row in enumerate(rows):
    for ci, (label, arr) in enumerate(row):
        crop = np.clip(arr[y0:y0 + 2 * half, x0:x0 + 2 * half], 0, 1)
        im = Image.fromarray((crop * 255).astype(np.uint8)).resize((cell, cell), Image.NEAREST)
        ox_, oy_ = ci * (cell + 5), ri * (cell + 24) + 22
        strip.paste(im, (ox_, oy_))
        if ri == 0:
            d.text((ox_ + 6, 6), label, fill=(255, 240, 120))
        if ci == 0:
            d.text((6, oy_ - 16), f"{label.split()[-1]}", fill=(150, 220, 255))
strip.save("build/fringe_compare.png")
print("wrote build/fringe_compare.png  (left=as shipped, right=re-bled from alpha>0.5)")

# how dark is the margin, numerically?
for label, arr in panels:
    m = (arr[..., 3] > 0) & (arr[..., 3] <= 128)
    if m.sum():
        print(f"  {label:32s} margin mean RGB {arr[m][:, :3].mean(axis=0).round(1)}  ({m.sum()} px)")
