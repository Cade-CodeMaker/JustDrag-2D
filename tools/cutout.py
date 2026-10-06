"""Cut the character out of an asset's reference image and prepare it for the shader.

    python -m tools.cutout <name> [--model isnet-anime] [--src PATH] [--from NAME]

`--src` is how a new asset starts: the image is copied to
`assets/<name>/input.png`. If the asset has no regions.json yet, a starter one
is scaffolded so the demo can be opened and tuned immediately -- the demo *is*
the region editor, so without a config there is nothing to open.

Two things matter for the shader downstream:
  1. clean alpha with no background halo (the original art has a white sticker
     outline that sits on a near-white background low in the frame)
  2. edge bleed -- colour pushed outward into the transparent margin, so when a
     region rotates the inverse-mapped samples never reach transparent pixels
"""
import argparse
import shutil

import numpy as np
from PIL import Image

from core import matting, paths

CHECKER = (88, 132)   # the two sanity-preview grounds: neutral, then magenta
PREVIEW_PX = 560


def scaffold_regions(asset, source_name=None):
    """Give a config-less asset a starter regions.json. Returns the path, or None."""
    if asset.regions_json.is_file():
        return None
    if source_name:
        src = paths.asset(source_name).regions_json
        if not src.is_file():
            raise SystemExit(f"{source_name}: has no regions.json to copy")
        asset.regions_json.write_text(src.read_text("utf-8"), "utf-8")
        print(f"regions: copied from asset {source_name!r}")
    else:
        template = paths.ROOT / "core" / "default_regions.json"
        asset.regions_json.write_text(template.read_text("utf-8"), "utf-8")
        print("regions: scaffolded a generic starter -- drag the control points to fit")
    return asset.regions_json


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("name", help="asset name, i.e. assets/<name>/")
    ap.add_argument("--model", default="isnet-anime", help="rembg model (default: %(default)s)")
    ap.add_argument("--src", help="image to import as this asset's input.png")
    ap.add_argument("--from", dest="source_name",
                    help="copy this asset's regions.json as the starting config")
    args = ap.parse_args()

    a = paths.asset(args.name)
    if args.src:
        a.dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.src, a.input_png)
        print(f"imported {args.src} -> {a.input_png}")
    if not a.input_png.is_file():
        raise SystemExit(f"{a.name}: no reference image.\n"
                         f"  pass --src PATH, or drop one at {a.input_png}")

    print(f"loading model: {args.model} (first run downloads weights)")
    cut = matting.cutout(a.input_png, args.model).convert("RGBA")

    rgb = np.asarray(cut)[..., :3].astype(np.float32)
    alpha = np.asarray(cut)[..., 3].astype(np.float32) / 255.0

    ys, xs = np.nonzero(alpha > 0.5)
    print(f"alpha>0.5 bbox: x {xs.min()}..{xs.max()}  y {ys.min()}..{ys.max()}")
    print(f"coverage: opaque {(alpha > 0.9).mean():.2%}  "
          f"soft {((alpha > 0.05) & (alpha < 0.9)).mean():.2%}")

    rgb = np.clip(matting.bleed(rgb, alpha), 0, 255)
    print(f"edge bleed: {matting.BLEED}px")

    # NOTE: the *original* alpha is written back, not the widened mask.
    out = a.out(f"character_{args.model}.png")
    Image.fromarray(np.dstack([rgb.astype(np.uint8), (alpha * 255).astype(np.uint8)]),
                    "RGBA").save(out)
    print(f"wrote {out}")

    # --- sanity previews: checkerboard catches a halo, magenta catches bad alpha ---
    h, w = alpha.shape
    yy, xx = np.mgrid[0:h, 0:w]
    ck = np.where((((yy // 16 + xx // 16) % 2) == 0)[..., None], *CHECKER) \
           .repeat(3, axis=2).astype(np.uint8)
    a3 = alpha[..., None]
    mag = np.zeros((h, w, 3), np.uint8)
    mag[...] = (255, 0, 255)
    for name, ground in (("prev_checker.png", ck), ("prev_magenta.png", mag)):
        flat = (rgb * a3 + ground * (1 - a3)).astype(np.uint8)
        Image.fromarray(flat).resize((PREVIEW_PX, PREVIEW_PX), Image.LANCZOS) \
             .save(a.out(name))
    print(f"wrote {a.out('prev_checker.png')}, {a.out('prev_magenta.png')}")

    scaffold_regions(a, args.source_name)
    print(f"\nnext:\n  python -m tools.preview {a.name}\n  python -m tools.build_demo {a.name}"
          f"\n  then open {a.out('demo.html')} and drag the control points")


if __name__ == "__main__":
    main()
