/*
 * Copy onnxruntime-web's runtime files into public/ort/.
 *
 * ORT resolves its .wasm next to the script URL, and under Vite's dev server
 * that URL does not exist -- the SPA fallback answers with index.html, and the
 * failure surfaces as the wonderfully indirect
 *
 *   WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 3c 21 64 6f
 *
 * (that is `<!do`). Pinning `ort.env.wasm.wasmPaths` at a real directory is the
 * fix; this script is what keeps that directory in sync with the installed
 * version instead of it being a hand-copied artefact.
 *
 *   node scripts/sync-ort.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(APP, 'node_modules', 'onnxruntime-web', 'dist');
const DST = path.join(APP, 'public', 'ort');

if (!fs.existsSync(SRC)) {
  console.error('onnxruntime-web is not installed; run npm install first');
  process.exit(1);
}

// Only the simd-threaded family: those are what the webgpu/wasm builds request
// at runtime. The plain .js bundles are pulled in by the bundler instead.
const wanted = fs.readdirSync(SRC)
  .filter(f => /^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(f));

if (!wanted.length) {
  console.error(`no ort-wasm-simd-threaded* files in ${SRC}`);
  process.exit(1);
}

fs.mkdirSync(DST, { recursive: true });
let bytes = 0;
for (const f of wanted) {
  fs.copyFileSync(path.join(SRC, f), path.join(DST, f));
  bytes += fs.statSync(path.join(DST, f)).size;
}

console.log(`synced ${wanted.length} files -> public/ort (${(bytes / 1048576).toFixed(1)} MB)`);
for (const f of wanted) console.log('  ' + f);
