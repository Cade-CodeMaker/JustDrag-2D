"""Dump an asset's weight field as raw RGBA bytes, for the cross-language test.

    python -m verify.dump_weights <name> <outfile> [--size 256]

Prints the sha256 and writes the bytes. Kept separate from the test so the JS
side can spawn it without knowing anything about Python beyond this contract.
"""
import argparse
import hashlib
import pathlib

from core import paths, region_field


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("name")
    ap.add_argument("out", help="file to write the raw RGBA bytes to")
    ap.add_argument("--size", type=int, default=256)
    args = ap.parse_args()

    regions = region_field.load_regions(paths.resolve(args.name).regions_json)
    data = region_field.rasterize(regions, args.size)
    raw = data.tobytes()
    pathlib.Path(args.out).write_bytes(raw)
    print(hashlib.sha256(raw).hexdigest())


if __name__ == "__main__":
    main()
