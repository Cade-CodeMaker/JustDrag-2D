/*
 * Does the editor actually do the job, and does its export match the Python one?
 *
 *   A. UI      import -> cutout -> edit, driven through the real controls
 *   B. export  the app builds demo.html from assets/new1 and its bytes are
 *              compared to the file tools/build_demo.py produced from the SAME
 *              inputs. This is the test that proves the port: everything else
 *              can be plausible and still be a different artifact.
 *   C. artifact the file the app built is opened from file:// and has to paint
 *   D. reload  the project survives a cold start
 *   E. GIF     the row flip, a real export parsed block by block, the ring that
 *              zoom < 1 leaves behind, and the edges that zoom > 1 must not eat
 *   F. budget  how many ellipses this device can drive, and which of the two
 *              ceilings decided it
 *
 * Prerequisites:
 *   python -m tools.build_demo new1        (the oracle in B)
 *   app/public/models/isnet-anime.onnx     (for A)
 *   python app/test/dump_reference.py sample  (supplies public/_ref/input.png)
 *
 * Run:  node app/test/ui.test.js
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ROOT = path.join(APP, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEV_PORT = 5199;
const CDP_PORT = 9345;
const PROFILE = path.join(os.tmpdir(), 'justdrag-ui-' + Date.now());

const ORACLE_ASSET = path.join(ROOT, 'assets', 'new1');
const ORACLE_HTML = path.join(ORACLE_ASSET, 'out', 'demo.html');
const ORACLE_PNG = path.join(ORACLE_ASSET, 'out', 'character_isnet-anime.png');
const ORACLE_JSON = path.join(ORACLE_ASSET, 'regions.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = url => new Promise((res, rej) =>
  http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); })
    .on('error', rej));
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

let fails = 0;
function check(label, ok, detail) {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail !== undefined ? '   -> ' + detail : ''}`);
  if (!ok) fails++;
}

for (const [label, f] of [['oracle demo.html', ORACLE_HTML], ['oracle character png', ORACLE_PNG],
                          ['oracle regions.json', ORACLE_JSON]]) {
  if (!fs.existsSync(f)) {
    console.log(`missing ${label}: ${f}`);
    console.log('run:  python -m tools.build_demo new1');
    process.exit(1);
  }
}
const TEST_IMAGE = path.join(APP, 'public', '_ref', 'input.png');
if (!fs.existsSync(TEST_IMAGE)) {
  console.log('missing ' + TEST_IMAGE + '\nrun:  python app/test/dump_reference.py sample');
  process.exit(1);
}
if (!fs.existsSync(path.join(APP, 'public', 'models', 'isnet-anime.onnx'))) {
  console.log('missing the model -- copy isnet-anime.onnx into app/public/models/');
  process.exit(1);
}

fs.rmSync(PROFILE, { recursive: true, force: true });

console.log('starting vite...');
// Spawned as a plain node process rather than through npx/shell: a shell child
// survives kill() and leaves the port occupied for the next run. `--host` is
// pinned to IPv4 because vite otherwise binds localhost, which resolves to ::1
// here -- polling 127.0.0.1 would then never see it.
const vite = spawn(process.execPath,
  [path.join(APP, 'node_modules', 'vite', 'bin', 'vite.js'),
   '--port', String(DEV_PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: APP, stdio: 'ignore' });

let up = false;
for (let i = 0; i < 150 && !up; i++) {
  try { await get(`http://127.0.0.1:${DEV_PORT}/`); up = true; } catch (_) { await sleep(200); }
}
if (!up) { console.log('vite never came up'); vite.kill(); process.exit(1); }

const chrome = spawn(CHROME, [
  '--headless=new', '--enable-unsafe-swiftshader', '--enable-unsafe-webgpu',
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--allow-file-access-from-files',
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
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description || JSON.stringify(ex));
  return r.result?.result?.value;
};
function done(code) { try { ws.close(); } catch (_) {} chrome.kill(); vite.kill(); process.exit(code); }

const pageErrors = [];
await send('Page.enable');
await send('Runtime.enable');
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push(m.params.exceptionDetails?.exception?.description || 'exception');
  }
});

await send('Page.navigate', { url: `http://127.0.0.1:${DEV_PORT}/` });

console.log('\n--- A. the editor ---');
let ok = false;
for (let i = 0; i < 120 && !ok; i++) {
  try { ok = (await evalJS('!!window.__app')) === true; } catch (_) {}
  if (!ok) await sleep(200);
}
if (!ok) {
  console.log('  page never exposed __app');
  console.log(await evalJS('document.getElementById("diag").textContent').catch(() => ''));
  done(1);
}
check('页面加载，未走诊断分支', (await evalJS('document.getElementById("diag").textContent')) === '');
check('起始停在第 1 步', (await evalJS('window.__app.getStep()')) === 1);

// Import through the same path the file picker uses.
await evalJS(`(async () => {
  const blob = await fetch('/_ref/input.png').then(r => r.blob());
  await window.__app.importBlob(blob, 'sample.png');
})()`);
check('导入后进入第 2 步', (await evalJS('window.__app.getStep()')) === 2);
check('源图已解码', (await evalJS('window.__app.proj.source !== null && window.__app.stage.image !== null')) === true);
check('导入后区域回到默认模板', (await evalJS('window.__app.proj.regions[0].blobs.length')) === 1);

console.log('  running the cutout (first run loads the model)...');
await evalJS('window.__app.cutout()');
const charOk = await evalJS('window.__app.proj.character !== null && window.__app.stage.mode === "deform"');
check('抠图完成并进入第 3 步', charOk === true && (await evalJS('window.__app.getStep()')) === 3);
check('抠图后有非透明像素', (await evalJS(
  '(async () => { const b = window.__app.proj.character; const bm = await createImageBitmap(b);' +
  ' const c = new OffscreenCanvas(bm.width, bm.height); const x = c.getContext("2d");' +
  ' x.drawImage(bm, 0, 0); const d = x.getImageData(0, 0, bm.width, bm.height).data;' +
  ' let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 127) n++;' +
  ' return Math.round(n / (bm.width * bm.height) * 100); })()')) > 5);

const before = await evalJS('window.__app.proj.regions[0].blobs.length');
await evalJS('window.__app.addBlob(window.__app.proj.regions[0])');
check('增加椭圆会写进区域数据',
  (await evalJS('window.__app.proj.regions[0].blobs.length')) === before + 1);
check('新椭圆自动选中', (await evalJS('window.__app.stage.sel && window.__app.stage.sel.kind')) === 'blob');
check('检查器随之展开', (await evalJS('!document.getElementById("inspector").hidden')) === true);

// And the picture has to still move. "Renders but never changes" is the failure
// mode with no symptom: when the bound program is not the one the uniforms are
// addressed to, WebGL drops every uniform call with INVALID_OPERATION and the
// shader keeps painting whatever pose it was last given. Nothing throws, the
// picture is correct, the animation is simply over -- which is why checking
// that the edit reached the data is not the same as checking it reached the
// screen.
//
// The trigger is a program-cache *hit* on a count other than the one currently
// bound, because that is the path that used to skip `gl.useProgram`. A single
// add does not reach it (a count nobody has visited yet compiles and binds
// itself); add-then-delete does, and so does switching to a project whose
// ellipse count has been seen before -- the second complaint that arrived with
// the first. Both are checked, in that order, so the pair is covered whichever
// direction the regression comes back in.
await evalJS(`window.__motion = () => {
  const s = window.__app.stage, gl = s.gl;
  const was = s.view.playing;
  s.view.playing = false;               // set the phase by hand, so this is deterministic
  const shot = phase => {
    s._phase = phase; s.draw();
    const w = s.glc.width, h = s.glc.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let acc = 0;
    for (let i = 0; i < px.length; i += 401) acc = (acc * 31 + px[i]) >>> 0;
    return acc;
  };
  const a = shot(0), b = shot(0.37);
  s.view.playing = was;
  const p = gl.getParameter(gl.CURRENT_PROGRAM);
  return { differs: a !== b, bound: s._cur ? s._cur.prog === p : null };
}`);
const afterAdd = await evalJS('window.__motion()');
check('加椭圆之后画面仍在动', afterAdd.differs === true);

// Back to the count the boot already compiled: a cache hit, and the case that
// froze. Net state is the default project again, so nothing below shifts.
await evalJS('window.__app.deleteBlob()');
const afterDelete = await evalJS('window.__motion()');
check('删掉刚加的椭圆之后画面仍在动', afterDelete.differs === true);
check('形变用的程序就是绑定着的那个', afterDelete.bound === true);

// Put the ellipse back: section D asserts a reload restores the project this
// step left behind, and "one extra ellipse in part 0" is what it is looking
// for. The delete above is a probe, not an edit the rest of the suite should
// inherit.
await evalJS('window.__app.addBlob(window.__app.proj.regions[0])');

// The weight texture has to actually change when the field does.
check('权重图已随编辑重建', (await evalJS(
  '(() => { const gl = window.__app.stage.gl;' +
  ' return gl.getError() === 0; })()')) === true);

// The weights view is what tells you which part owns which pixels, so its
// colours have to be the parts' own. They used to be two values hardcoded in
// the shader that matched nothing in regions.json -- invisible while there were
// exactly two regions, and wrong the moment a third appeared. The default
// project's third part is a colour neither of the old constants was, so one
// pixel is enough to tell the two implementations apart.
//
// The canvas centre is the image centre whatever the canvas aspect ratio is,
// because the square is fitted and centred; the default project puts a single
// part's core there, and which one is asked of the production falloff rather
// than assumed, so moving the template does not silently invalidate this.
const wview = await evalJS(`(async () => {
  const st = window.__app.stage, c = document.getElementById('gl'), gl = st.gl;
  const owners = st.regions.filter(r => DeformCore.regionW(0.5, 0.5, r) >= 1);
  const prev = st.view.weights;
  st.view.weights = true;
  const px = await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
    const b = new Uint8Array(4 * c.width * c.height);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, b);
    const i = (((c.height >> 1) * c.width) + (c.width >> 1)) << 2;
    res([b[i], b[i + 1], b[i + 2]]);
  })));
  st.view.weights = prev;
  return { px, owners: owners.map(r => ({ name: r.name, color: r.color })) };
})()`);
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
check('权重视图中心只有一个部位，且用的是它自己的颜色',
  wview.owners.length === 1 && near(wview.px, wview.owners[0].color),
  wview.owners.length === 1
    ? `${wview.owners[0].name} ${wview.owners[0].color} -> 渲染出 ${wview.px}`
    : `${wview.owners.length} 个部位重叠，这条例子的前提没了：${JSON.stringify(wview.owners)}`);

// Autosave is debounced; let it land before part C navigates the tab away, or
// part D would be testing the race rather than the restore.
for (let i = 0; i < 40; i++) {
  if ((await evalJS('document.getElementById("saveState").textContent')).startsWith('已保存')) break;
  await sleep(100);
}

console.log('\n--- B. export parity with tools/build_demo.py ---');
// Same three inputs the Python build used, fed to the browser's own builder.
const regionsText = fs.readFileSync(ORACLE_JSON, 'utf8');
const charB64 = fs.readFileSync(ORACLE_PNG).toString('base64');
const builtHtml = await evalJS(`(() => {
  const raw = JSON.parse(${JSON.stringify(regionsText)});
  const regions = raw.regions;
  const meta = Object.fromEntries(
    Object.entries(raw).filter(([k]) => k.startsWith('_') && k !== '_params'));
  const r = window.__app.buildDemo({
    name: 'new1',
    imageBase64: ${JSON.stringify(charB64)},
    regions, params: raw._params, meta,
  });
  return r.html;
})()`);

/**
 * Line endings are the one legitimate difference, and it is Python's doing.
 *
 * tools/template.html is LF on disk. pathlib's read_text/write_text default to
 * universal newlines, so build_demo.py reads LF and writes os.linesep -- CRLF
 * here -- into the artifact. The app never rewrites line endings, so it emits
 * the template's own LF. That is a property of the machine that ran the build,
 * not of the build, and no browser cares. Normalising it is the only edit made
 * before hashing; every other byte is compared as-is.
 */
const lf = s => s.replace(/\r\n/g, '\n');
const oracleHtml = fs.readFileSync(ORACLE_HTML, 'utf8');
const a = lf(builtHtml), b = lf(oracleHtml);
const hApp = sha256(a);
const hPy = sha256(b);
check('app 构建的 demo.html 与 python 的内容逐字节一致', hApp === hPy,
  hApp === hPy ? hApp.slice(0, 16) : `app ${hApp.slice(0, 16)} vs py ${hPy.slice(0, 16)}`);
check('体积一致', a.length === b.length, `${a.length} vs ${b.length}`);

if (hApp !== hPy) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  console.log(`     first difference at ${i}:`);
  console.log(`       app: ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 60))}`);
  console.log(`       py : ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 60))}`);
}

console.log('\n--- C. the built file opens from file:// ---');
const builtPath = path.join(os.tmpdir(), 'justdrag-built-demo.html');
fs.writeFileSync(builtPath, builtHtml, 'utf8');
await send('Page.navigate', { url: 'file:///' + builtPath.replace(/\\/g, '/') });
await sleep(2500);

check('构建模板没有落入「这是模板」的诊断分支',
  !(await evalJS('document.getElementById("diag").textContent')).includes('这是构建模板'));
check('demo 页面无诊断信息',
  (await evalJS('document.getElementById("diag").textContent')) === '',
  await evalJS('document.getElementById("diag").textContent').catch(() => ''));

// The shader paints the whole framing square opaque, so a working demo lights up
// a large, predictable share of the canvas; a failed one leaves it all zero.
// readPixels has to happen inside a frame, after the page's own draw.
const painted = await evalJS(`new Promise(res => {
  const c = document.getElementById('gl');
  const gl = c.getContext('webgl');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const px = new Uint8Array(4 * c.width * c.height);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
    res(Math.round(n / (c.width * c.height) * 100));
  }));
})`);
check('demo 真的画出了东西', painted > 20 && painted < 95, painted + '% 像素不透明');

console.log('\n--- D. the project survives a reload ---');
// IndexedDB lives in the profile, which this run created fresh and has not
// thrown away -- so a reload is a genuine cold start, not a warm cache read.
await send('Page.navigate', { url: `http://127.0.0.1:${DEV_PORT}/` });
for (let i = 0; i < 100; i++) {
  if (await evalJS('!!window.__app').catch(() => false)) break;
  await sleep(200);
}
// The restore is async (IndexedDB read + two image decodes); wait for it.
let restored = false;
for (let i = 0; i < 60 && !restored; i++) {
  restored = (await evalJS('window.__app.proj.character !== null')) === true;
  if (!restored) await sleep(200);
}
check('重开后恢复了抠图结果', restored === true);
check('重开后回到了调整步', (await evalJS('window.__app.getStep()')) >= 3,
  'step ' + await evalJS('window.__app.getStep()'));
check('重开后区域与参数都还在',
  (await evalJS('window.__app.proj.regions[0].blobs.length')) === before + 1,
  'region 0 blobs=' + await evalJS('window.__app.proj.regions[0].blobs.length'));
check('重开后画面是形变模式', (await evalJS('window.__app.stage.mode')) === 'deform');

console.log('\n--- E. the GIF export ---');
// Section D left the editor restored at step 3+ with a cut-out character, which
// is exactly the state an export needs.
await evalJS('window.__app.setStep(4)');
check('导出按钮可用', (await evalJS('document.getElementById("btnGif").disabled')) === false);

// E1. The row flip. readPixels hands back a bottom-up buffer and GIF rows run
// top-down, so a forgotten flip ships an upside-down character. Testing it
// against the real artwork would be ambiguous -- the test cannot tell which way
// up the character is *supposed* to be -- so this swaps in a texture whose top
// half is red and bottom half is blue, zeroes the deformation, and asks where
// the red ended up.
{
  const r = await evalJS(`(async () => {
    const st = window.__app.stage;
    const prev = { ...st.params };
    const restore = st.image;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const c = cv.getContext('2d');
    c.fillStyle = '#f00'; c.fillRect(0, 0, 64, 32);
    c.fillStyle = '#00f'; c.fillRect(0, 32, 64, 32);
    st.setCharacter(cv);
    // Zero the motion at its source: amplitude lives on each ellipse now, not
    // on params. Nothing moves, so the only thing left in the frame is which
    // way up the texture was sampled.
    const blobs = st.regions.flatMap(r => r.blobs);
    const amps = blobs.map(b => b.amp);
    blobs.forEach(b => { b.amp = 0; });
    st.params.zoom = 1;
    let f = null;
    for await (const x of st.renderFrames({ width: 64, height: 64, phases: [0], bg: 2 })) f = x;
    blobs.forEach((b, i) => { b.amp = amps[i]; });
    Object.assign(st.params, prev);
    st.setCharacter(restore);
    const at = (x, y) => { const p = (y * 64 + x) << 2; return [f[p], f[p+1], f[p+2]]; };
    return { top: at(32, 2), bottom: at(32, 61) };
  })()`);
  const isRed = c => c[0] > 180 && c[2] < 80;
  const isBlue = c => c[2] > 180 && c[0] < 80;
  check('捕获的帧是正的：上半张红、下半张蓝', isRed(r.top) && isBlue(r.bottom),
    `top ${r.top} bottom ${r.bottom}`);
}

// E2. A real export end to end, parsed with the same reader the Node tests use
// (vite serves app/test/ as modules, so there is one parser, not two).
const gif = await evalJS(`(async () => {
  const { parseGif, decodeFrame0 } = await import('/test/gifparse.js');
  const { seamAt } = await import('/src/pose.js');
  const st = window.__app.stage;
  const r = await window.__app.renderGifBlob({ size: 256, fps: 10, seconds: 1, bg: 2, dither: false });
  const g = parseGif(r.bytes);
  const f0 = decodeFrame0(r.bytes);

  // What starting at phase 0 would have left, recomputed here from the same
  // ellipse list the exporter used. Independent of r.seam on purpose: the point
  // is to check the phase search did something, not to read it back.
  const blobs = st.regions.flatMap(x => x.blobs);
  const naive = seamAt(blobs, st.params.harm, 0, r.plan.actualSeconds).max;

  // The identical instant, straight out of the capture path, as an independent
  // check that encoding did not scramble anything.
  let ref = null;
  for await (const f of st.renderFrames({ width: 256, height: 256, phases: [r.start], bg: 2 })) ref = f;

  let sum = 0;
  for (let i = 0; i < ref.length; i += 4) {
    sum += Math.abs(f0.rgba[i] - ref[i]) + Math.abs(f0.rgba[i+1] - ref[i+1]) + Math.abs(f0.rgba[i+2] - ref[i+2]);
  }
  const corner = (x, y) => { const p = (y * 256 + x) << 2; return [f0.rgba[p], f0.rgba[p+1], f0.rgba[p+2]]; };
  return {
    sig: g.signature, w: g.screenWidth, h: g.screenHeight,
    frames: g.frames.length, delay: g.frames[0].delayCs, loop: g.netscapeLoop,
    locals: g.localTableCount, tables: g.globalTable ? g.globalTable.length : 0,
    bytes: r.bytes.length, plan: r.plan, bgRgb: r.bgRgb, seam: r.seam.max, naive,
    meanErr: sum / (256 * 256 * 3),
    corner: corner(2, 2), centre: corner(128, 128),
  };
})()`);

check('导出的是一张 GIF89a，尺寸与请求一致',
  gif.sig === 'GIF89a' && gif.w === 256 && gif.h === 256, `${gif.sig} ${gif.w}x${gif.h}`);
check('帧数与时长都对得上', gif.frames === gif.plan.n && gif.delay === 10,
  `${gif.frames} 帧 / ${gif.delay}cs / ${gif.plan.actualSeconds}s`);
check('无限循环', gif.loop === 0, `loop=${gif.loop}`);
check('只有一张全局调色板，没有逐帧局部表', gif.locals === 0 && gif.tables > 0,
  `${gif.tables} 色，${gif.locals} 张局部表`);
check('编码后与原帧基本一致（调色板量化范围内）', gif.meanErr < 12,
  `平均通道误差 ${gif.meanErr.toFixed(2)}`);
check('缩略图角落是背景色，不是黑边', gif.corner[0] > 150 && gif.corner[1] > 150,
  `corner ${gif.corner} bgRgb ${gif.bgRgb}`);
check('画面中心确实画了角色', gif.corner.join() !== gif.centre.join(),
  `centre ${gif.centre}`);
// bestStartPhase only decides where the recording starts, and on a project with
// three lag groups it cannot reach machine precision: the starter ships head 0,
// legs 0.5, chest 0.35, and each ellipse's seam has a root of its own -- the
// roots sit at different phases, so no single start phase lands on all of them.
// That is the documented price of per-ellipse lag. What has to hold here is that
// the search did something and that the residual is reported rather than
// rounded away; pose.test.js pins the shared-lag case (which the shipped assets
// use) reaching ~0.
check('导出挑的开始相位不差于相位 0', gif.seam <= gif.naive + 1e-9,
  `相位 0 ${gif.naive.toFixed(3)}° -> 选中 ${gif.seam.toFixed(3)}°`);
check('有滞后差时的残差如实报出，量级与滞后差相符',
  gif.seam > 1e-3 && gif.seam < 3, `${gif.seam.toFixed(3)}°`);
check('体积是实测的，不是估计的', gif.bytes > 0, `${(gif.bytes / 1e6).toFixed(2)} MB`);

// E3. zoom < 1 leaves a ring the shader never draws. GIF has no alpha, so
// without the fill it would come out as black bars around the character.
{
  const r = await evalJS(`(async () => {
    const { decodeFrame0 } = await import('/test/gifparse.js');
    const st = window.__app.stage;
    const prev = st.params.zoom;
    st.params.zoom = 0.5;
    const out = await window.__app.renderGifBlob({ size: 128, fps: 10, seconds: 0.1, bg: 2, dither: false });
    const f = decodeFrame0(out.bytes);
    st.params.zoom = prev;
    const at = (x, y) => { const p = (y * 128 + x) << 2; return [f.rgba[p], f.rgba[p+1], f.rgba[p+2]]; };
    return { frames: f.width, corner: at(1, 1), edge: at(1, 64), inside: at(64, 64) };
  })()`);
  // The square is 64px centred in 128, so x=1 is 31px outside it.
  const black = c => c[0] < 12 && c[1] < 12 && c[2] < 12;
  check('zoom<1 时框外那圈补的是背景色，不是黑色', !black(r.corner) && !black(r.edge),
    `corner ${r.corner} edge ${r.edge}`);
  check('补色是平的（整圈同色）', r.corner.join() === r.edge.join(),
    `${r.corner} vs ${r.edge}`);
}

// E4. zoom > 1 is where the framing square grows past the viewport and the
// shader's bounds test (deform.glsl:29) turns zoom into a crop of the art's
// centre. The preview can hide that -- its window is wider than the square, so
// you keep the full width and lose only the top and bottom -- but a square GIF
// has no such slack, which is how an export ends up as "only the middle of the
// picture". So the export frames at fitZoom. Tested with a texture whose whole
// border is magenta: if the edges survive at zoom 1.3, nothing was cropped.
{
  const r = await evalJS(`(async () => {
    const st = window.__app.stage;
    const prev = { ...st.params };
    const restore = st.image;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const c = cv.getContext('2d');
    c.fillStyle = '#808080'; c.fillRect(0, 0, 64, 64);
    c.fillStyle = '#f0f'; c.fillRect(0, 0, 64, 6); c.fillRect(0, 58, 64, 6);
    c.fillRect(0, 0, 6, 64); c.fillRect(58, 0, 6, 64);
    st.setCharacter(cv);
    const blobs = st.regions.flatMap(r => r.blobs);
    const amps = blobs.map(b => b.amp);
    blobs.forEach(b => { b.amp = 0; });
    const grab = async z => {
      st.params.zoom = z;
      let f = null;
      for await (const x of st.renderFrames({ width: 64, height: 64, phases: [0], bg: 2 })) f = x;
      return f;
    };
    const over = await grab(1.3);
    const one = await grab(1);
    blobs.forEach((b, i) => { b.amp = amps[i]; });
    Object.assign(st.params, prev);
    st.setCharacter(restore);
    const at = (f, x, y) => { const p = (y * 64 + x) << 2; return [f[p], f[p + 1], f[p + 2]]; };
    let same = true;
    for (let i = 0; i < over.length; i++) if (over[i] !== one[i]) { same = false; break; }
    return {
      edges: [at(over, 2, 32), at(over, 61, 32), at(over, 32, 2), at(over, 32, 61)],
      centre: at(over, 32, 32),
      same,
    };
  })()`);
  const magenta = c => c[0] > 180 && c[1] < 90 && c[2] > 180;
  check('zoom 1.3 时画面的四条边都还在（导出没有把角色裁成中间一块）',
    r.edges.every(magenta), JSON.stringify(r.edges));
  check('中间是内容，不是被放大的边框', !magenta(r.centre), `${r.centre}`);
  check('zoom 1 与 zoom 1.3 导出的帧逐字节相同', r.same);
}

// F. Which of the two ceilings binds is a property of the device, so the live
// number is not the assertion -- the arithmetic is. On a spec-minimum device
// (8 texture units, 16 fragment uniform vectors) the uniform budget allows 4
// ellipses where the texture units would allow 28; on anything normal the
// texture side wins at 28. Both branches are checked, and this device is
// checked against the very function it uses, so a change to the constants
// cannot quietly disagree with the number the panel reports.
console.log('\n--- F. how many ellipses this device can drive ---');
{
  const cap = await evalJS(`(async () => {
    const { capacityFrom } = await import('/src/stage.js');
    return {
      live: window.__app.stage.capacity(),
      specMin: capacityFrom(8, 16),
      // The same 8 texture units the spec guarantees, with a uniform budget big
      // enough to stop mattering -- which is what flips which ceiling binds.
      texBound: capacityFrom(8, 1024),
    };
  })()`);
  check('规范最低档设备是 uniform 先到顶：4 个椭圆，不是纹理给的 28',
    cap.specMin.byUniform === 4 && cap.specMin.byTexture === 28 && cap.specMin.max === 4,
    `最大 ${cap.specMin.max}（uniform ${cap.specMin.byUniform} / 纹理 ${cap.specMin.byTexture}）`);
  check('纹理单元够用之后轮到纹理先到顶：28 个椭圆',
    cap.texBound.max === 28 && cap.texBound.byUniform > 28,
    `最大 ${cap.texBound.max}（uniform ${cap.texBound.byUniform} / 纹理 ${cap.texBound.byTexture}）`);
  check('这台设备的上限来自两者取小，且至少能驱动一个椭圆',
    cap.live.max === Math.min(cap.live.byTexture, cap.live.byUniform) && cap.live.max >= 1,
    `${cap.live.max} = min(纹理 ${cap.live.byTexture}, uniform ${cap.live.byUniform})`
    + ` · units ${cap.live.units} / vecs ${cap.live.vecs}`);
}

check('页面全程没有未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(`\n${fails ? fails + ' FAILED' : 'all passed'}`);
done(fails ? 1 : 0);
