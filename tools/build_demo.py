"""Inline the cutout + region config into tools/template.html -> out/demo.html.

    python -m tools.build_demo <name> [--model isnet-anime]

Produces one self-contained file that runs from a plain double-click -- no
server, no CORS trouble, because the texture goes in as a data URI.
"""
import argparse
import base64
import json
import pathlib
import re
import shutil
import subprocess

from core import paths, region_field

TPL = pathlib.Path(__file__).resolve().parent / "template.html"
CORE = paths.ROOT / "core"

# _params.zoom is a factor; its slider is in percent.
BAKE_SCALE = {"zoom": 100}

# Exactly the fields the runtime reads, in the order it reads them. Mirrors
# projectRegions() in app/src/regions.js -- the two builders produce the same
# artifact from the same input, and ui.test.js compares them byte for byte, so
# this tuple and that function have to agree about both membership and order.
REGION_KEYS = ("name", "pivot", "color", "amp", "spd")
BLOB_KEYS = ("c", "r", "rot", "amp", "spd", "delay")

PLACEHOLDERS = ("__IMAGE_BASE64__", "__REGIONS_JSON__", "__REGIONS_META_JSON__",
                "__WEIGHT_JS__", "__DEFORM_GLSL__", "__LS_SUFFIX__", "__BUILT__")

# The page ships exactly one <script> block, and the extractor below depends on
# that. Adding a second one would make the non-greedy-free regex below swallow
# the tags in between and hand `node --check` something that is not valid JS.
SCRIPT_RE = re.compile(r"<script>\n(.*)\n</script>", re.S)


def bake_sliders(html, params):
    """Rewrite each slider's value= attribute from the asset's `_params`.

    Baking at build time instead of branching at runtime is what keeps the
    built page, its 重置 button and its built-in defaults in agreement without
    any special-casing -- the markup stays the single source of truth.
    """
    baked, sliders = [], []

    def one(match):
        tag = match.group(0)
        idm = re.search(r'id="([\w-]+)"', tag)
        if not idm:
            return tag
        key = idm.group(1)
        sliders.append(key)
        if key not in params:
            return tag
        val = params[key] * BAKE_SCALE.get(key, 1)
        baked.append(f"{key}={val:g}")
        return re.sub(r'value="[^"]*"', f'value="{val:g}"', tag, count=1)

    return re.sub(r'<input[^>]*type="range"[^>]*>', one, html), baked, sliders


def project(reg):
    """One region, narrowed to the fields the runtime reads, in read order."""
    out = {k: reg[k] for k in REGION_KEYS if k in reg}
    out["blobs"] = [{k: b[k] for k in BLOB_KEYS if k in b} for b in reg.get("blobs", [])]
    return out


def js_numbers(o):
    """Rewrite integral floats as ints, so the dump spells numbers like JSON.stringify.

    JSON has one number type -- 1.0 and 1 are the same value -- but Python keeps
    the distinction and writes "1.0" where JS writes "1". Without this the
    artifact depends on how a hand-written file happened to spell a number, and
    the byte-for-byte agreement with the browser's build (ui.test.js, section B)
    breaks on nothing worse than a trailing ".0". -0.0 goes to 0 as well, which
    is what JS does with it.
    """
    if isinstance(o, float):
        return int(o) if o.is_integer() else o
    if isinstance(o, dict):
        return {k: js_numbers(v) for k, v in o.items()}
    if isinstance(o, list):
        return [js_numbers(v) for v in o]
    return o


def read_core(name, forbid=()):
    """Read an inlined source file, refusing anything that would break the page.

    Substituting source into a build is exactly where a stray `</script>` or a
    backtick turns into a blank page at runtime, so it fails here instead.
    """
    text = (CORE / name).read_text("utf-8")
    for bad in forbid:
        assert bad not in text, f"core/{name} contains {bad!r}; it cannot be inlined"
    return text


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("name", nargs="?",
                    help="asset name; optional while only one asset exists")
    ap.add_argument("--model", help="cutout variant (only needed if several exist)")
    args = ap.parse_args()

    a = paths.resolve(args.name)
    cut = a.character_png(args.model)
    if not a.regions_json.is_file():
        raise SystemExit(f"{a.name}: no regions.json -- run: python -m tools.cutout {a.name}")

    cfg = region_field.load_regions(a.regions_json)
    params = region_field.load_params(a.regions_json)
    meta = region_field.load_meta(a.regions_json)

    # Project to what the runtime needs. A whitelist rather than a copy, so a
    # hand-written regions.json can carry notes without them reaching the
    # artifact -- and key order and float values are carried through untouched,
    # because they end up verbatim inside demo.html and the browser's build has
    # to come out byte-identical to this one.
    regions = [project(r) for r in cfg]

    html = TPL.read_text("utf-8")
    html, baked, sliders = bake_sliders(html, params)
    print(f"baked {len(baked)} slider default(s): {', '.join(baked) if baked else '(none)'}")
    # A misspelled _params key bakes nothing and says nothing; call it out here.
    stale = [k for k in params if k not in sliders]
    if stale:
        print(f"warning: _params has no slider for {', '.join(stale)} -- ignored")

    for ph in PLACEHOLDERS:
        assert ph in html, f"placeholder {ph} missing from {TPL}"
    html = html.replace("__IMAGE_BASE64__", base64.b64encode(cut.read_bytes()).decode("ascii"))
    # ensure_ascii=False because the browser's build (exporter.js) spells these
    # with JSON.stringify, which never escapes non-ASCII -- a region named 头部
    # is those three characters there and "头部" here, and ui.test.js
    # compares the two files byte for byte. Both dumps are strings inside one
    # <script>, so neither may escape U+2028/U+2029 either, for the same reason.
    html = html.replace("__REGIONS_JSON__",
                        json.dumps(js_numbers(regions), separators=(",", ":"),
                                   ensure_ascii=False))
    # The page rewrites this whole file on save, so it needs the "_" keys that
    # load_regions() drops. "<" is escaped so a _comment containing "</script>"
    # cannot terminate the inline script block.
    html = html.replace("__REGIONS_META_JSON__",
                        json.dumps(meta, separators=(",", ":"), ensure_ascii=False)
                        .replace("<", "\\u003c"))
    html = html.replace("__WEIGHT_JS__", read_core("region_field.js", forbid=("</script>",)))
    # the shader lands inside a template literal, so it must not close or escape it
    html = html.replace("__DEFORM_GLSL__", read_core("deform.glsl", forbid=("`", "${")))
    html = html.replace("__LS_SUFFIX__", f"{a.name}-v1")
    html = html.replace('"__BUILT__"', "true")   # quotes included: replaces the literal

    leftover = re.findall(r"__[A-Z_]+__", html)
    assert not leftover, f"unreplaced placeholders: {set(leftover)}"

    out = a.out("demo.html")
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out}  ({out.stat().st_size / 1e6:.2f} MB)")

    # A broken build should fail here, loudly, not as a blank page later.
    m = SCRIPT_RE.search(html)
    if not m:
        raise SystemExit("could not extract the <script> block (expected exactly one)")
    check_file = a.out("_demo_check.js")
    check_file.write_text(m.group(1), encoding="utf-8")
    node = shutil.which("node")
    if node:
        r = subprocess.run([node, "--check", str(check_file)], capture_output=True, text=True)
        if r.returncode:
            raise SystemExit(f"built JS does not parse:\n{r.stderr}")
        print("node --check: ok")
    else:
        print(f"node not on PATH; syntax unchecked (dumped to {check_file})")


if __name__ == "__main__":
    main()
