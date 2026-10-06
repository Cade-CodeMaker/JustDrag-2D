/*
 * Does the Python weight field still agree with the JS one?
 *
 *   node verify/test_weight_golden.js [name]        (default: sample)
 *
 * The field is implemented twice on purpose. core/region_field.js is what the
 * browser runs; core/region_field.py is the offline oracle that tools/preview.py
 * and the verify/ diagnostics are built on. Neither is generated from the other,
 * so this test is the only thing stopping them from drifting apart -- and it is
 * what makes the Python renderer trustworthy as a reference for the shader.
 *
 * A few 1-LSB disagreements are tolerated: JS uses Math.hypot, numpy uses sqrt,
 * so the last bit can differ. Anything larger is a genuine divergence.
 *
 * Runs the project's own conda env `justdrag`. Override with PY if your shell is
 * already inside it and `python` resolves there -- see README "环境".
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const NAME = process.argv[2] || "sample";
const SIZE = 256;
const PY = process.env.PY || "D:/coding/conda/envs/justdrag/python.exe";

// tolerances: a last-bit disagreement is fine, a real divergence is not
const MAX_ABS_DIFF = 1;
const MAX_DIFF_FRACTION = 0.0001;   // 0.01% of channels

const DeformCore = require(path.join(REPO, "core", "region_field.js"));

// The ordered region list, exactly as core/region_field.py's load_regions()
// reads it -- the file wraps it next to `_params` and `_comment`, which the
// field itself never sees.
const file = JSON.parse(
  fs.readFileSync(path.join(REPO, "assets", NAME, "regions.json"), "utf8"));
const regions = Array.isArray(file) ? file : (file.regions || []);

const js = Buffer.from(DeformCore.rasterize(regions, SIZE));

const tmp = path.join(os.tmpdir(), `justdrag-weights-${NAME}-${Date.now()}.bin`);
let pySha;
try {
  pySha = execFileSync(PY, ["-m", "verify.dump_weights", NAME, tmp], { cwd: REPO })
    .toString().trim();
} catch (e) {
  console.error(`could not run the Python side:\n  ${PY} -m verify.dump_weights ${NAME} <tmp>`);
  console.error("  set PY to a python with numpy (see README)");
  console.error(String(e.stderr || e.message).trim());
  process.exit(2);
}
const py = fs.readFileSync(tmp);
fs.rmSync(tmp, { force: true });

let diff = 0, maxDiff = 0, firstAt = -1;
const n = Math.min(js.length, py.length);
for (let i = 0; i < n; i++) {
  const d = Math.abs(js[i] - py[i]);
  if (d) {
    diff++;
    if (firstAt < 0) firstAt = i;
    if (d > maxDiff) maxDiff = d;
  }
}

const channels = js.length;
const frac = diff / channels;
console.log(`asset ${NAME}   weight field ${SIZE}x${SIZE}, ${channels} bytes`);
console.log(`  js  length ${js.length}   py length ${py.length}`);
console.log(`  py sha256  ${pySha}`);
console.log(`  differing channels  ${diff}  (${(frac * 100).toFixed(4)}%)`
  + (diff ? `  first at ${firstAt}  max |diff| ${maxDiff}` : ""));

const ok = js.length === py.length && maxDiff <= MAX_ABS_DIFF && frac <= MAX_DIFF_FRACTION;
console.log(ok
  ? "\nPASS  the two weight fields agree\n"
  : "\nFAIL  the Python and JS weight fields have diverged\n");
process.exit(ok ? 0 : 1);
