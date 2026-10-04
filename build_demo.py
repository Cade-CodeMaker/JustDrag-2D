"""Inline the cutout + region config into demo.template.html -> build/demo.html.

Produces one self-contained file that runs from a plain double-click (no server,
no CORS problems, since the texture is a data URI).

    D:\\coding\\conda\\envs\\art\\python.exe build_demo.py
"""
import base64
import json
import re
import pathlib

CUT = pathlib.Path("build/character_isnet-anime.png")
TPL = pathlib.Path("demo.template.html")
OUT = pathlib.Path("build/demo.html")

b64 = base64.b64encode(CUT.read_bytes()).decode("ascii")
cfg = json.loads(pathlib.Path("regions.json").read_text("utf-8"))
params = cfg.get("_params") or {}          # optional: bake tuned slider values as the defaults
# keep only what the runtime needs
regions = {k: {"pivot": v["pivot"], "color": v["color"], "blobs": v["blobs"]}
           for k, v in cfg.items() if not k.startswith("_")}

html = TPL.read_text("utf-8")

# Bake _params by rewriting the slider defaults in the markup, so the built page,
# its "重置" button and its built-ins all agree without any runtime special-casing.
# (_params.zoom is a factor; the slider is percent.)
BAKE_SCALE = {"zoom": 100}
baked = []


def bake_slider(m):
    tag = m.group(0)
    idm = re.search(r'id="([\w-]+)"', tag)
    if not idm or idm.group(1) not in params:
        return tag
    key = idm.group(1)
    val = params[key] * BAKE_SCALE.get(key, 1)
    baked.append(f"{key}={val:g}")
    return re.sub(r'value="[^"]*"', f'value="{val:g}"', tag, count=1)


html = re.sub(r'<input[^>]*type="range"[^>]*>', bake_slider, html)
print(f"baked {len(baked)} slider default(s): {', '.join(baked) if baked else '(none)'}")
for ph in ("__IMAGE_BASE64__", "__REGIONS_JSON__", '__BUILT__'):
    assert ph in html, f"placeholder {ph} missing from {TPL}"
html = html.replace("__IMAGE_BASE64__", b64)
html = html.replace("__REGIONS_JSON__", json.dumps(regions, separators=(",", ":")))
html = html.replace('"__BUILT__"', "true")   # quotes included: replaces the string literal

# sanity: no stray placeholders, and the JS still parses
leftover = re.findall(r"__[A-Z_]+__", html)
assert not leftover, f"unreplaced placeholders: {set(leftover)}"

OUT.parent.mkdir(exist_ok=True)
OUT.write_text(html, encoding="utf-8")
print(f"wrote {OUT}  ({OUT.stat().st_size / 1e6:.2f} MB)")

# dump the JS out for a syntax check by the caller
script = re.search(r"<script>\n(.*)\n</script>", html, re.S).group(1)
pathlib.Path("build/_demo_check.js").write_text(script, encoding="utf-8")
print("wrote build/_demo_check.js for `node --check`")
