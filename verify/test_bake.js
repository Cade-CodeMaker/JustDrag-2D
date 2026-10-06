/*
 * Does the bake really make per-ellipse channels add back up to per-region
 * coverage?
 *
 *   node verify/test_bake.js [name]        (default: sample)
 *
 * The whole refactor rests on one identity. The texture used to hold one
 * channel per region, holding that region's coverage -- the max over its
 * ellipses. It now holds one channel per ellipse, so a region's channels have
 * to sum back to the same number or the shader's weighted sum changes meaning.
 *
 * Scaling each channel by k_r = M_r / S_r does that, and the interesting part
 * is what quantisation does to it. Each channel is truncated once, after the
 * multiply, so the region's channels sum to
 *
 *     sum_i trunc(255 * w_i * k_r)  =  255 * M_r  -  sum_i frac_i
 *
 * and the region's old channel was trunc(255 * M_r) = 255 * M_r - frac_M. The
 * shortfall is therefore sum_i frac_i - frac_M, which lies in (-1, n_r) -- and
 * being a difference of integers it must be in {0, ..., n_r - 1}. So the new
 * channels can fall short of the old one by at most n_r - 1 LSB and can never
 * overshoot. Both directions are asserted below, over every pixel.
 *
 * With n_r = 1 the factor is M/S = w/w, which IEEE defines as exactly 1.0, so
 * that case is bit-identical to never having scaled at all -- asserted as
 * equality, not as a tolerance that happens to be met.
 *
 * Pure Node: the invariant is arithmetic on the buffer rasterize() returns, so
 * it needs no GPU, no browser and no Chrome. The synthetic configurations are
 * here because the shipped asset only exercises the easy cases -- it has no
 * fully overlapping ellipses, no region larger than one texture and (once the
 * degenerate case is guarded) no way to produce a NaN.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const NAME = process.argv[2] || "sample";
const PY = process.env.PY || "D:/coding/conda/envs/justdrag/python.exe";

const DeformCore = require(path.join(REPO, "core", "region_field.js"));

let fails = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail !== undefined ? "   -> " + detail : ""}`);
  if (!ok) fails++;
}

/**
 * Byte offset of flat ellipse channel `c`. Spelled out here rather than taken
 * from the module: the layout is the contract, so the test should fail if the
 * module changes its mind about it, not follow along.
 */
const chanAt = (c, px, size) => (Math.floor(c / 4) * size * size + px) * 4 + (c % 4);

/** What a region's single channel held before the refactor. */
const oldChannel = (reg, x, y) => Math.trunc(255 * DeformCore.regionW(x, y, reg));

/** Sample points matching rasterize()'s, so both see the same pixel centres. */
const sampleX = (i, size) => (i + 0.5) / size;

/**
 * Every assertion that should hold for any region list, at any size.
 *
 * Returns the buffer so a caller can go on to compare it against Python.
 */
function audit(regions, size, label) {
  const n = regions.reduce((s, r) => s + r.blobs.length, 0);
  const nTex = DeformCore.textureCount(n);
  const data = DeformCore.rasterize(regions, size);

  check(`${label}: buffer is ${nTex} texture(s) for ${n} ellipses`,
    data.length === nTex * size * size * 4,
    `${data.length}B, expected ${nTex * size * size * 4}B`);

  // Padding: channels from n up to 4*nTex - 1 are never read by the shader,
  // and must stay zero so that a driver which hoists the uniform reads finds
  // nothing to contribute. (Zero weight is what makes that safe regardless.)
  let padDirty = -1;
  for (let c = n; c < nTex * 4 && padDirty < 0; c++) {
    for (let px = 0; px < size * size; px++) {
      if (data[chanAt(c, px, size)] !== 0) { padDirty = c; break; }
    }
  }
  check(`${label}: padding channels 0..${nTex * 4 - 1} hold nothing from ${n}`,
    padDirty < 0, padDirty < 0 ? "all clean" : `channel ${padDirty} is not zero`);

  // The invariant itself, over every pixel of every region.
  let lo = 0, worstShort = 0, worstOver = 0, shortPx = 0, overPx = 0, overChannel = 0, exact = true;
  for (const reg of regions) {
    const nR = reg.blobs.length;
    if (nR) {
      for (let j = 0; j < size; j++) {
        const y = sampleX(j, size);
        for (let i = 0; i < size; i++) {
          const px = j * size + i;
          const old = oldChannel(reg, sampleX(i, size), y);
          let sum = 0;
          for (let b = 0; b < nR; b++) {
            const v = data[chanAt(lo + b, px, size)];
            if (v > old) overChannel++;      // w_i * k <= M, so no channel may exceed the coverage
            sum += v;
          }
          const d = old - sum;
          if (d > 0) { shortPx++; if (d > worstShort) worstShort = d; }
          else if (d < 0) { overPx++; if (-d > worstOver) worstOver = -d; }
          if (old !== data[chanAt(lo, px, size)]) exact = false;
        }
      }
      const budget = Math.max(0, nR - 1);
      check(`${label}: region of ${nR} sums to its coverage within ${budget} LSB`,
        worstShort <= budget && worstOver <= budget && overChannel === 0,
        `short ${worstShort}, over ${worstOver}, ${overChannel} channels above coverage`
        + `  [${shortPx} px short, ${overPx} px over]`);

      if (nR === 1) {
        check(`${label}: region of 1 is bit-identical to the old channel`, exact);
      }
    }
    lo += nR;
  }
  return data;
}

/** One rotated soft ellipse. */
const blob = (cx, cy, rx, ry, rot = 0) => ({ c: [cx, cy], r: [rx, ry], rot });

console.log("--- A. the shipped asset ---");
{
  const file = JSON.parse(fs.readFileSync(
    path.join(REPO, "assets", NAME, "regions.json"), "utf8"));
  const regions = Array.isArray(file) ? file : (file.regions || []);
  const n = regions.reduce((s, r) => s + r.blobs.length, 0);
  console.log(`  ${NAME}: ${regions.length} regions, ${n} ellipses`);
  audit(regions, 256, NAME);
}

console.log("\n--- B. synthetic shapes the asset does not contain ---");
{
  // Two ellipses exactly on top of each other: S = 2w, k = 0.5, so each channel
  // carries half. This is the worst case for the truncation budget, because
  // both terms lose a fraction every pixel rather than only at the rim.
  audit([{ blobs: [blob(0.5, 0.5, 0.3, 0.3), blob(0.5, 0.5, 0.3, 0.3)] }], 64, "identical pair");

  // Overlapping but offset: exercises pixels where M is one ellipse's and S is
  // both, and the far field where only one contributes at all.
  audit([{ blobs: [blob(0.40, 0.5, 0.25, 0.3), blob(0.60, 0.5, 0.25, 0.3)] }], 64, "overlapping pair");

  // Disjoint: S == M wherever anything is covered, so k == 1 and the channels
  // should carry their weights unscaled.
  audit([{ blobs: [blob(0.2, 0.5, 0.15, 0.2), blob(0.8, 0.5, 0.15, 0.2)] }], 64, "disjoint pair");

  // Rotated, so the inverse rotation is exercised rather than being an identity.
  audit([{ blobs: [blob(0.35, 0.45, 0.2, 0.3, 37), blob(0.65, 0.55, 0.25, 0.15, -52)] }], 64, "rotated pair");

  // Five ellipses in one region: two textures, so the second texture and its
  // three padding channels are real rather than incidental.
  audit([{ blobs: [blob(0.3, 0.3, 0.2, 0.2), blob(0.7, 0.3, 0.2, 0.2), blob(0.5, 0.5, 0.2, 0.2),
                   blob(0.3, 0.7, 0.2, 0.2), blob(0.7, 0.7, 0.2, 0.2)] }], 64, "five in one region");

  // A region with no ellipses contributes nothing and must not disturb the
  // channel numbering of the regions after it.
  audit([{ blobs: [] }, { blobs: [blob(0.5, 0.5, 0.3, 0.3)] }, { blobs: [] }], 64, "empty regions interleaved");

  // Nothing at all: still one texture, all zero.
  audit([{ blobs: [] }], 64, "no ellipses anywhere");

  // A degenerate ellipse. It contributes nothing, so the region must behave
  // exactly as if it were not there -- which for a lone sibling means k = M/S
  // = w/w = 1 and the channel carries the full coverage. Unguarded, the 0/0
  // makes S NaN, k collapses to 0, and every channel in the region zeroes out:
  // one bad ellipse silently freezing a whole body part.
  {
    const alone = audit([{ blobs: [blob(0.5, 0.5, 0.3, 0.3)] }], 64, "guard: alone");
    const withDegenerate = audit([{ blobs: [blob(0.5, 0.5, 0.3, 0.3), blob(0.5, 0.5, 0, 0)] }], 64,
                                 "guard: zero-radius sibling");
    check("guard: a zero-radius sibling leaves the live channel untouched",
      alone.every((v, i) => v === withDegenerate[i]),
      `${alone.length} bytes, all equal to the region with no degenerate sibling`);
  }
}

console.log("\n--- C. the Python port agrees on the awkward shapes too ---");
{
  // The golden test pins the two implementations against the shipped asset,
  // which has none of the shapes above. These are the ones where a divergence
  // would actually be introduced -- an accumulation order, a clamp, a guard.
  const cases = {
    "identical-pair": [{ blobs: [blob(0.5, 0.5, 0.3, 0.3), blob(0.5, 0.5, 0.3, 0.3)] }],
    "overlapping-pair": [{ blobs: [blob(0.40, 0.5, 0.25, 0.3), blob(0.60, 0.5, 0.25, 0.3)] }],
    "rotated-pair": [{ blobs: [blob(0.35, 0.45, 0.2, 0.3, 37), blob(0.65, 0.55, 0.25, 0.15, -52)] }],
    "five-in-one": [{ blobs: [blob(0.3, 0.3, 0.2, 0.2), blob(0.7, 0.3, 0.2, 0.2), blob(0.5, 0.5, 0.2, 0.2),
                              blob(0.3, 0.7, 0.2, 0.2), blob(0.7, 0.7, 0.2, 0.2)] }],
    "zero-radius-sibling": [{ blobs: [blob(0.5, 0.5, 0.3, 0.3), blob(0.5, 0.5, 0, 0)] }],
    "empty-region": [{ blobs: [] }, { blobs: [blob(0.5, 0.5, 0.3, 0.3)] }],
  };
  const SIZE = 64;
  const script = `
import json, sys
from core import region_field as rf
regions = json.load(open(sys.argv[1], encoding="utf-8"))
sys.stdout.buffer.write(rf.rasterize(regions, int(sys.argv[2])).tobytes())
`;
  for (const [name, regions] of Object.entries(cases)) {
    const tmp = path.join(os.tmpdir(), `justdrag-bake-${name}-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(regions));
    let py;
    try {
      py = execFileSync(PY, ["-c", script, tmp, String(SIZE)],
        { cwd: REPO, maxBuffer: 1 << 28 });
    } catch (e) {
      console.error(`  could not run the Python side for ${name}: ${String(e.stderr || e.message).trim()}`);
      fails++;
      continue;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const js = Buffer.from(DeformCore.rasterize(regions, SIZE));
    let diff = 0, maxDiff = 0;
    for (let i = 0; i < Math.min(js.length, py.length); i++) {
      const d = Math.abs(js[i] - py[i]);
      if (d) { diff++; if (d > maxDiff) maxDiff = d; }
    }
    check(`python matches on ${name}`, js.length === py.length && maxDiff <= 1,
      `${js.length}B vs ${py.length}B, ${diff} differing, max |diff| ${maxDiff}`);
  }
}

console.log(fails ? `\n${fails} FAILED\n` : "\nall passed\n");
process.exit(fails ? 1 : 0);
