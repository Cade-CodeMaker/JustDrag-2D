"""Offline reference renderer for the deformation shader.

Mirrors the GLSL in the demo exactly, so the motion can be checked visually
before the WebGL build. Renders a contact sheet across one animation cycle,
plus a weight-map view.

    D:\\coding\\conda\\envs\\art\\python.exe preview_anim.py
"""
import json
import numpy as np
from PIL import Image

CUT = "build/character_isnet-anime.png"
REGIONS = {k: v for k, v in json.load(open("regions.json", encoding="utf-8")).items()
           if not k.startswith("_")}
OUT = "build/anim_sheet.png"

INNER, OUTER = 0.75, 1.35      # blob falloff band, in multiples of the radius
HEAD_AMP, HEAD_SPEED = 4.5, 1.0   # degrees, cycles per loop
LEG_AMP, LEG_SPEED = 6.0, 1.0
PHASE = 0.5                        # legs lag the head by half a cycle

img = Image.open(CUT).convert("RGBA")
W, H = img.size
src = np.asarray(img).astype(np.float32) / 255.0

yy, xx = np.mgrid[0:H, 0:W]
px = ((xx + 0.5) / W).astype(np.float32)
py = ((yy + 0.5) / H).astype(np.float32)


def blob_weight(uv_x, uv_y, blobs):
    """Union of soft ellipses -> how strongly this pixel follows the region."""
    w = np.zeros(uv_x.shape, np.float32)
    for b in blobs:
        cx, cy = b["c"]; rx, ry = b["r"]; th = np.radians(b["rot"])
        dx, dy = uv_x - cx, uv_y - cy
        u = dx * np.cos(th) + dy * np.sin(th)
        v = -dx * np.sin(th) + dy * np.cos(th)
        d = np.sqrt((u / rx) ** 2 + (v / ry) ** 2)
        w = np.maximum(w, np.clip(1.0 - (d - INNER) / (OUTER - INNER), 0.0, 1.0))
    return w


weights = {k: blob_weight(px, py, v["blobs"]) for k, v in REGIONS.items()}
print("coverage: " + "  ".join(f"{k}={v.mean():.1%}" for k, v in weights.items()))


def deform(head_deg, leg_deg):
    """Inverse-map every output pixel back to its source, then bilinear sample."""
    total = np.zeros((H, W), np.float32)
    ox = np.zeros((H, W), np.float32)
    oy = np.zeros((H, W), np.float32)
    for key, deg in (("head", head_deg), ("legs", leg_deg)):
        pxx, pyy = REGIONS[key]["pivot"]
        th = np.radians(-deg)                    # inverse rotation
        ct, st = np.cos(th), np.sin(th)
        dx, dy = px - pxx, py - pyy
        sx = pxx + (dx * ct - dy * st) - px      # displacement to source
        sy = pyy + (dx * st + dy * ct) - py
        w = weights[key]
        total += w
        ox += w * sx
        oy += w * sy
    # keep the blend convex where regions ever overlap
    scale = np.where(total > 1.0, 1.0 / np.maximum(total, 1e-6), 1.0)
    ox *= scale
    oy *= scale

    u = (px + ox) * W - 0.5
    v = (py + oy) * H - 0.5
    x0 = np.clip(np.floor(u).astype(np.int32), 0, W - 1)
    y0 = np.clip(np.floor(v).astype(np.int32), 0, H - 1)
    x1 = np.clip(x0 + 1, 0, W - 1)
    y1 = np.clip(y0 + 1, 0, H - 1)
    fx = np.clip(u - x0, 0, 1)[..., None]
    fy = np.clip(v - y0, 0, 1)[..., None]
    out = (src[y0, x0] * (1 - fx) * (1 - fy) + src[y0, x1] * fx * (1 - fy) +
           src[y1, x0] * (1 - fx) * fy + src[y1, x1] * fx * fy)
    return out


def on_checker(rgba):
    a = rgba[..., 3:]
    ck = np.where((((yy // 16 + xx // 16) % 2) == 0)[..., None], 88, 132).repeat(3, axis=2) / 255.0
    return rgba[..., :3] * a + ck * (1 - a)


# --- contact sheet across one cycle ---
N = 6
tiles = []
for i in range(N):
    t = i / N
    hd = HEAD_AMP * np.sin(2 * np.pi * t * HEAD_SPEED)
    ld = LEG_AMP * np.sin(2 * np.pi * (t * LEG_SPEED + PHASE))
    tiles.append((t, hd, ld, on_checker(deform(hd, ld))))

cell = 340
sheet = Image.new("RGB", (cell * 3, cell * 2), (24, 24, 28))
from PIL import ImageDraw
for i, (t, hd, ld, rgb) in enumerate(tiles):
    tile = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).resize((cell, cell), Image.LANCZOS)
    sheet.paste(tile, ((i % 3) * cell, (i // 3) * cell))
    d = ImageDraw.Draw(sheet)
    d.text(((i % 3) * cell + 10, (i // 3) * cell + 10), f"t={t:.2f}  head {hd:+.1f}d  legs {ld:+.1f}d", fill=(255, 240, 120))
sheet.save(OUT)
print(f"wrote {OUT}")

# --- weight map view ---
wm = np.zeros((H, W, 3), np.float32)
for k, v in REGIONS.items():
    wm += np.array(v["color"], np.float32) / 255.0 * weights[k][..., None] * 0.75
base = on_checker(src)
over = np.clip(base * (1 - 0.6 * np.maximum.reduce(list(weights.values()))[..., None]) +
               wm, 0, 1)
Image.fromarray((over * 255).astype(np.uint8)).resize((560, 560), Image.LANCZOS).save("build/anim_weights.png")
print("wrote build/anim_weights.png")
