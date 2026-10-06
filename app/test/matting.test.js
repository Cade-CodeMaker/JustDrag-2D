/*
 * Does the browser compute the same matte the Python pipeline does?
 *
 * Two checks, deliberately separated:
 *
 *   A. tensor parity -- Python's own preprocessed tensor is fed to
 *      onnxruntime-web, so the resize filter is out of the picture and any
 *      difference is the runtime. This is the one that proves the port.
 *   B. end-to-end    -- the whole browser pipeline against Python's mask. This
 *      one CAN differ, because the browser resizes with a canvas filter and PIL
 *      uses LANCZOS; the threshold says how much that is allowed to cost.
 *
 * Prerequisite:  python app/test/dump_reference.py sample
 * Run:           node app/test/matting.test.js
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEV_PORT = 5199;
const CDP_PORT = 9344;
const PROFILE = path.join(os.tmpdir(), 'justdrag-mating-' + Date.now());

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = url => new Promise((res, rej) =>
  http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); })
    .on('error', rej));

let fails = 0;
function check(label, ok, detail) {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail !== undefined ? '   -> ' + detail : ''}`);
  if (!ok) fails++;
}

if (!fs.existsSync(path.join(APP, 'public', '_ref', 'tensor.bin'))) {
  console.log('missing app/public/_ref/tensor.bin');
  console.log('run:  python app/test/dump_reference.py sample');
  process.exit(1);
}

fs.rmSync(PROFILE, { recursive: true, force: true });

console.log('starting vite...');
// Spawned as a plain node process rather than through npx/shell: a shell child
// survives kill() and leaves the port occupied for the next run. And `--host`
// is pinned to IPv4 because vite otherwise binds localhost, which resolves to
// ::1 here -- so polling 127.0.0.1 would never see it.
const vite = spawn(process.execPath,
  [path.join(APP, 'node_modules', 'vite', 'bin', 'vite.js'),
   '--port', String(DEV_PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: APP, stdio: 'ignore' });

let up = false;
for (let i = 0; i < 150 && !up; i++) {
  try { await get(`http://127.0.0.1:${DEV_PORT}/`); up = true; } catch (_) { await sleep(200); }
}
if (!up) { console.log('vite never came up'); vite.kill(); process.exit(1); }
console.log('vite up on ' + DEV_PORT);

const chrome = spawn(CHROME, [
  '--headless=new', '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu',
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

let tabs = [];
for (let i = 0; i < 100 && !tabs.length; i++) {
  try {
    tabs = JSON.parse(await get(`http://127.0.0.1:${CDP_PORT}/json/list`)).filter(t => t.type === 'page');
  } catch (_) {}
  if (!tabs.length) await sleep(200);
}
if (!tabs.length) { console.log('could not reach the debugger'); chrome.kill(); vite.kill(); process.exit(1); }

const ws = new WebSocket(tabs[0].webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const send = (method, params = {}) => new Promise(res => {
  const id = ++seq; pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evalJS = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

function done(code) { try { ws.close(); } catch (_) {} chrome.kill(); vite.kill(); process.exit(code); }

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${DEV_PORT}/` });

// 168MB of model over localhost, plus a cold wasm/WebGPU session.
console.log('waiting for the session...');
let ok = false;
for (let i = 0; i < 300 && !ok; i++) {
  try { ok = (await evalJS('!!window.__probe')) === true; } catch (_) {}
  if (!ok) await sleep(500);
}
if (!ok) {
  console.log('page never exposed __probe:');
  console.log(await evalJS('document.getElementById("diag").textContent').catch(() => '(unreadable)'));
  done(1);
}
try { await evalJS('window.__probe.ready'); }
catch (e) { console.log('session failed to init: ' + e.message); done(1); }

const providers = await evalJS('JSON.stringify(window.__probe.providers())');
console.log('\n0. backend');
check('wasm backend is always offered', /wasm/.test(providers), providers);
console.log('     ' + (providers.includes('webgpu')
  ? 'WebGPU bound -- this is the fast path'
  : 'WebGPU unavailable in this headless run; correctness is still meaningful, speed is not'));

console.log('\n1. tensor parity -- same input tensor, browser ORT vs python ORT');
const a = await evalJS('window.__probe.compareTensor()');
console.log(`     ${a.n} values in ${a.ms.toFixed(0)}ms`);
console.log(`     max |diff| ${a.maxAbs.toExponential(3)}   mean |diff| ${a.meanAbs.toExponential(3)}`);
console.log(`     over 1e-3: ${a.overPct.toFixed(4)}%   first: got ${a.first[0].toFixed(8)} want ${a.first[1].toFixed(8)}`);
check('outputs agree to float32 noise', a.maxAbs < 1e-4, 'max=' + a.maxAbs.toExponential(3));

console.log('\n2. end-to-end -- browser pipeline vs python mask');
const b = await evalJS('window.__probe.runPipeline()');
console.log(`     ${b.w}x${b.h} in ${b.ms.toFixed(0)}ms`);
for (const m of b.marks) console.log(`       ${m.stage.padEnd(14)} ${m.ms.toFixed(0)}ms`);
console.log(`     mask max |diff| ${b.maxAbs}   mean ${b.meanAbs.toFixed(4)}   >8 by ${b.over8Pct.toFixed(3)}%`);
check('a plausible amount of character was cut out', b.opaquePct > 5 && b.opaquePct < 95,
  b.opaquePct.toFixed(1) + '% opaque');
check('end-to-end mask tracks python', b.over8Pct < 1.0, b.over8Pct.toFixed(3) + '% of pixels differ by >8');

console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}`);
done(fails ? 1 : 0);
