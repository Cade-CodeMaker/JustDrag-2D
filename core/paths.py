"""Project layout -- the one place that knows where an asset's files live.

    assets/<name>/input.png       reference image    (authoritative, local-only)
    assets/<name>/regions.json    region config      (authoritative, local-only)
    assets/<name>/out/            generated output   (local-only, disposable)

`assets/` is excluded wholesale by .gitignore -- the art is not ours to publish and
regions.json is hand-tuned against one local image. Only placeholder files live in git;
see assets/README.md.

Every script goes through here rather than assembling paths by hand, so adding
a second reference image needs no edits outside `assets/`.
"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS_DIR = ROOT / "assets"

# Windows-illegal characters and control codes. CJK, spaces and dashes are fine.
_ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


class Asset:
    """Paths for one reference image. Build these with `asset(name)`."""

    def __init__(self, name):
        if not name or name in (".", "..") or _ILLEGAL.search(name):
            raise ValueError(f"illegal asset name: {name!r}")
        self.name = name
        self.dir = ASSETS_DIR / name

    @property
    def input_png(self):
        return self.dir / "input.png"

    @property
    def regions_json(self):
        return self.dir / "regions.json"

    def out(self, *parts):
        """A path inside this asset's output dir. Parent dirs are created."""
        p = self.dir.joinpath("out", *parts)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def character_png(self, model=None):
        """The cutout to render. Without `model`, only an unambiguous match passes."""
        found = sorted(self.dir.glob("out/character_*.png"))
        if model:
            hit = [p for p in found if p.stem == f"character_{model}"]
            if not hit:
                raise FileNotFoundError(
                    f"{self.name}: no cutout for model {model!r} -- run tools.cutout first")
            return hit[0]
        if not found:
            raise FileNotFoundError(
                f"{self.name}: no cutout yet -- run: python -m tools.cutout {self.name}")
        if len(found) > 1:
            have = ", ".join(p.stem[len("character_"):] for p in found)
            raise FileNotFoundError(
                f"{self.name}: several cutouts ({have}); choose one with --model")
        return found[0]


def asset(name):
    return Asset(name)


def names():
    """Every asset that has an input image, sorted."""
    if not ASSETS_DIR.is_dir():
        return []
    return sorted(p.name for p in ASSETS_DIR.iterdir() if (p / "input.png").is_file())


def resolve(name):
    """The named asset, or the only one when the name is left out.

    Never guesses between several: picking the wrong asset silently would
    rebuild the wrong demo.
    """
    if name:
        return Asset(name)
    found = names()
    if len(found) == 1:
        return Asset(found[0])
    if not found:
        raise SystemExit("no assets yet -- drop an image at assets/<name>/input.png")
    raise SystemExit("several assets exist, name one of: " + ", ".join(found))
