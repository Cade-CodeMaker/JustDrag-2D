"""Dump the reference tensors the browser port is checked against.

    python app/test/dump_reference.py [name]        (default: sample)

Writes into app/public/_ref/ (gitignored):

    tensor.bin    the exact preprocessed input rembg feeds the model
    pred.bin      the raw model output for that input
    mask.png      the final mask, at the source image's own resolution

`tensor.bin` is the load-bearing one. The browser's own preprocessing resizes
with a canvas filter rather than PIL's LANCZOS, so comparing end-to-end masks
would conflate two differences at once. Feeding the browser the *same* tensor
isolates the question that actually matters -- does onnxruntime-web compute what
onnxruntime-python computes -- from the resize, which is inherent and expected.
"""
import sys

sys.path.insert(0, __file__.rsplit("app", 1)[0].rstrip("\\/"))

import numpy as np
from PIL import Image
from rembg.session_factory import new_session

from core import paths

NAME = sys.argv[1] if len(sys.argv) > 1 else "sample"
OUT = paths.ROOT / "app" / "public" / "_ref"
OUT.mkdir(parents=True, exist_ok=True)

asset = paths.asset(NAME)
session = new_session("isnet-anime")
img = Image.open(asset.input_png).convert("RGB")

# Exactly what DisSession.predict feeds the model. std is (1,1,1) here, not
# ImageNet's -- see the header note in app/src/matting.js.
feeds = session.normalize(img, (0.485, 0.456, 0.406), (1.0, 1.0, 1.0), (1024, 1024))
key = list(feeds)[0]
tensor = feeds[key].astype(np.float32)
tensor.tofile(OUT / "tensor.bin")

pred = session.inner_session.run(None, feeds)[0].astype(np.float32)
pred.tofile(OUT / "pred.bin")

mask = session.predict(img)[0]
mask.save(OUT / "mask.png")

# Copied, not referenced: the test page is served over http and assets/ lives
# outside the app's public root, so it has to be reachable from the server.
Image.open(asset.input_png).save(OUT / "input.png")

(src_w, src_h) = img.size
print(f"asset      {asset.dir}")
print(f"source     {src_w}x{src_h}")
print(f"tensor     {tensor.shape} {tensor.dtype}  -> tensor.bin ({tensor.nbytes} B)")
print(f"pred       {pred.shape}  range [{pred.min():.6f}, {pred.max():.6f}]")
print(f"mask       {mask.size} mode={mask.mode}  -> mask.png")
