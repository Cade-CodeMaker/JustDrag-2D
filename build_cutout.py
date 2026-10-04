"""Cut the character out of sample.png and prepare it for the deformation shader.

Run with the `art` conda env:
    D:\\coding\\conda\\envs\\art\\python.exe build_cutout.py

Two things matter for the shader downstream:
  1. clean alpha with no background halo (the original has a white sticker
     outline that sits on a near-white background low in the frame)
  2. "edge bleed" -- colour pushed outward into the transparent margin, so when
     a region rotates the inverse-mapped samples never reach transparent or
     stale pixels
"""
import pathlib
import sys
import numpy as np
from PIL import Image, ImageFilter
from rembg import remove, new_session

SRC = "sample.png"
MODEL = sys.argv[1] if len(sys.argv) > 1 else "isnet-anime"
OUT = f"build/character_{MODEL}.png"
BLEED = 8  # px of colour dilation into the transparent margin

pathlib.Path(OUT).parent.mkdir(parents=True, exist_ok=True)

print(f"loading model: {MODEL} (first run downloads weights)")
session = new_session(MODEL)

src = Image.open(SRC).convert("RGB")
cut = remove(src, session=session).convert("RGBA")
rgb = np.asarray(cut)[..., :3].astype(np.float32)
alpha = np.asarray(cut)[..., 3].astype(np.float32) / 255.0

ys, xs = np.nonzero(alpha > 0.5)
print(f"alpha>0.5 bbox: x {xs.min()}..{xs.max()}  y {ys.min()}..{ys.max()}")
print(f"coverage: opaque {(alpha > 0.9).mean():.2%}  soft {((alpha > 0.05) & (alpha < 0.9)).mean():.2%}")

# --- edge bleed: repeatedly push known colour one pixel outward ---
a8 = (alpha * 255).astype(np.uint8)
rgb8 = rgb.astype(np.uint8)
for i in range(BLEED):
    known = a8 > 0
    if known.all():
        break
    acc = np.zeros_like(rgb, dtype=np.float64)
    cnt = np.zeros(a8.shape, dtype=np.float64)
    for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)):
        sh_rgb = np.roll(np.roll(rgb, dy, axis=0), dx, axis=1)
        sh_k = np.roll(np.roll(known, dy, axis=0), dx, axis=1).astype(np.float64)
        acc += sh_rgb * sh_k[..., None]
        cnt += sh_k
    grow = (~known) & (cnt > 0)
    if not grow.any():
        break
    rgb[grow] = (acc[grow] / cnt[grow][:, None])
    a8[grow] = 1
print(f"edge bleed: {BLEED}px ({i + 1} passes)")

# --- un-premultiply-ish cleanup: composite onto neutral so bleed colour is sane ---
rgb = np.clip(rgb, 0, 255)
out = np.dstack([rgb.astype(np.uint8), (alpha * 255).astype(np.uint8)])
img = Image.fromarray(out, "RGBA")
img.save(OUT)
print(f"wrote {OUT}")

# --- previews on checkerboard (halo check) and magenta (missing-alpha check) ---
h, w = alpha.shape
yy, xx = np.mgrid[0:h, 0:w]
ck = np.where((((yy // 16 + xx // 16) % 2) == 0)[..., None], 88, 132).repeat(3, axis=2).astype(np.uint8)
a = alpha[..., None]
Image.fromarray((rgb * a + ck * (1 - a)).astype(np.uint8)).resize((560, 560), Image.LANCZOS).save("build/prev_checker.png")
mag = np.zeros((h, w, 3), np.uint8); mag[...] = (255, 0, 255)
Image.fromarray((rgb * a + mag * (1 - a)).astype(np.uint8)).resize((560, 560), Image.LANCZOS).save("build/prev_magenta.png")
print("wrote build/prev_checker.png, build/prev_magenta.png")
