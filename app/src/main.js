/**
 * The editor: import -> cut out -> adjust -> export, all in one page.
 *
 * Replaces the old flow, which was a sequence of shell commands over
 * assets/<name>/ plus hand-edited JSON. Nothing here talks to a server; the
 * only network request in the whole app is the one-time model download.
 */
import * as M from './matting.js';
import { Stage, BG_NAMES, normDeg, bgColorOf } from './stage.js';
import {
  PARAMS, REGION_PARAMS, BLOB_PARAMS, MAX_BLOBS, regionColorAt,
  defaultParams, defaultRegions, sanitizeParams, normalizeRegions, flatBlobs,
} from './regions.js';
import { buildDemo, regionsJson, parseRegionsJson, slug, DEFAULT_COMMENT } from './exporter.js';
import * as P from './project.js';
import {
  framePlan, phasesFor, bestStartPhase, seamAt, frameRect, fitZoom,
  GIF_FPS, GIF_SIZES, GIF_SECONDS,
} from './pose.js';
import { encodeGif, samplePalette } from './gif.js';
import * as parity from './parity.js';
import {
  decodeImage, cutoutToCanvas, canvasToBlob, blobToBase64,
  makeThumb, download,
} from './imageutil.js';

const $ = id => document.getElementById(id);
const $$ = sel => [...document.querySelectorAll(sel)];

// ------------------------------------------------------------- failures ---

/** DESIGN 5.7: a failure is an interface with a reason, never a blank screen. */
function fatal(err) {
  const d = $('diag');
  const text = (err && (err.stack || err.message)) || String(err);
  d.textContent = (d.textContent ? d.textContent + '\n\n' : '') + text;
  d.classList.add('on');
}
addEventListener('error', e => fatal(e.error || e.message));
addEventListener('unhandledrejection', e => fatal(e.reason));

// ---------------------------------------------------------------- state ---

const proj = {
  id: P.newId(),
  name: '未命名项目',
  srcName: '',
  created: Date.now(),
  updated: Date.now(),
  step: 1,
  source: null,      // Blob: the image as imported
  character: null,   // Blob: RGBA PNG, bled colour + original alpha
  regions: defaultRegions(),
  params: defaultParams(),
  meta: { _comment: DEFAULT_COMMENT },
  thumb: null,
};

let srcImage = null;   // decoded source, drawable
let charImage = null;  // decoded cutout, drawable -- OffscreenCanvas or ImageBitmap
let step = 1;

const time = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

// ---------------------------------------------------------------- stage ---

const stage = new Stage($('gl'), $('ov'), {
  onSelect: () => syncInspector(),
  onEdit: () => { syncInspector(); scheduleSave(); },
  // The stage refuses to render once a project outgrows the device's uniform
  // budget, and this is how it says so. Silently drawing a wrong picture would
  // read as a tuning mistake rather than as a limit.
  onDiag: text => {
    const el = $('capWarn');
    el.textContent = text;
    el.hidden = !text;
  },
});
stage.params = proj.params;
// Declared up here, not next to the panel code below, because the first
// applyRegions() runs before any of that and refills it: a `let` further down
// the module is in its temporal dead zone at this point, and the boot would
// throw before the page ever exposed itself.
let regionUI = [];    // parallel to stage.regions: one block per body part
// Attached before anything can call setStep(), which syncs the inspector and so
// dereferences stage.regions. The stage holds the same object the project does,
// so an edit made on the canvas is an edit to proj.regions.
applyRegions(proj.regions);

/**
 * Swap in a whole new region list.
 *
 * Every path that replaces the list rather than editing it -- import, load,
 * reset, importing a regions.json -- goes through here, because the panel
 * mirrors the list by holding a live reference per region. Handing the stage a
 * new array without regenerating the panel would leave sliders wired to regions
 * that are no longer on screen.
 */
function applyRegions(regions) {
  proj.regions = regions;
  stage.setRegions(regions);
  buildRegionList();
}

// ------------------------------------------------------------- busy ui ----

function busy(on, text) {
  $('busy').classList.toggle('on', !!on);
  if (text !== undefined) busyText(text);
  if (on) busyProgress(0);
}
const busyText = t => { $('busyText').textContent = t; };
const busyProgress = pct => { $('busyBar').style.width = Math.max(0, Math.min(100, pct)) + '%'; };

const STAGE_LABEL = {
  'preprocess': '预处理…',
  'infer': '推理中…',
  'resize mask': '还原遮罩…',
  'sample colour': '取色…',
  'edge bleed': '边缘扩散…',
};

// -------------------------------------------------------------- session ---

/**
 * WebGPU first, wasm always. Not a nicety: this model is 1024x1024 and the wasm
 * backend is several times slower, so which one binds is a product-visible fact
 * and gets reported rather than hidden.
 */
let providerList = null;
async function detectProviders() {
  if (providerList) return providerList;
  const list = [];
  try {
    if (navigator.gpu && (await navigator.gpu.requestAdapter())) list.push('webgpu');
  } catch (_) { /* no WebGPU: the wasm path still has to work */ }
  list.push('wasm');
  providerList = list;
  return list;
}

let sessionPromise = null;
function ensureSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const providers = await detectProviders();
      $('backend').innerHTML = `可用后端：<b>${providers.join(', ')}</b>`
        + (providers.includes('webgpu') ? '（WebGPU，快）' : '（没有 WebGPU，改用 CPU，会慢一些）');
      return await M.createSession('/models/isnet-anime.onnx', {
        providers,
        onProgress: (seen, total) => {
          busyText(`下载模型 ${(seen / 1048576).toFixed(0)} / ${total ? (total / 1048576).toFixed(0) : '?'} MB`);
          busyProgress(total ? (seen / total) * 100 : 0);
        },
      });
    })().catch(e => {
      fatal(e);
      sessionPromise = null;   // let the next click retry rather than caching the failure
      throw e;
    });
  }
  return sessionPromise;
}

// --------------------------------------------------------------- steps ----

const maxStep = () => (charImage ? 4 : srcImage ? 2 : 1);
const canGo = n => n <= maxStep();

function setStep(n) {
  n = Math.max(1, Math.min(n, maxStep()));
  step = n;
  proj.step = n;

  for (const el of $$('.step')) {
    const s = +el.dataset.step;
    el.classList.toggle('on', s === n);
    el.classList.toggle('done', s !== n && s <= maxStep());
    el.disabled = !canGo(s);
  }
  for (const el of $$('.pane')) el.classList.toggle('on', +el.dataset.pane === n);

  $('drop').classList.toggle('hide', !!srcImage);
  $('stagebar').hidden = n !== 3;

  // Steps 1-2 are stills; from 3 on the shader is what the user is judging.
  stage.mode = n >= 3 && charImage ? 'deform' : 'image';
  // Guides are step 3's editing furniture -- step 4 previews the real thing.
  stage.showGuides = n === 3;
  stage.image = charImage || srcImage;
  stage.draw();
  syncInspector();
  updateGates();
  scheduleSave();
}

function updateGates() {
  $('toStep2').disabled = !srcImage;
  $('toStep3').disabled = !charImage;
  $('btnCut').disabled = !srcImage || !!charImage;
  $('btnCutAgain').hidden = !charImage;
  $('btnExport').disabled = !charImage;
  $('btnExportTop').disabled = !charImage;
  $('btnRegions').disabled = !charImage;
  $('btnGif').disabled = !charImage;
}

// --------------------------------------------------------------- import ---

async function importSource(file) {
  if (!file || !file.type.startsWith('image/')) {
    fatal(new Error('请拖入 PNG 或 JPG 图片。'));
    return;
  }
  srcImage = await decodeImage(file);
  proj.source = file;
  proj.srcName = file.name || '';
  proj.thumb = await makeThumb(srcImage);
  // A new image invalidates the cut-out, and the regions with it: they are
  // normalized to a figure that no longer exists.
  proj.character = null;
  charImage = null;
  proj.regions = defaultRegions();
  applyRegions(proj.regions);
  stage.image = srcImage;

  if (proj.name === '未命名项目') {
    proj.name = (file.name || '').replace(/\.[^.]+$/, '') || '未命名项目';
    $('projName').value = proj.name;
  }
  updateSrcInfo();
  setStep(2);
}

function updateSrcInfo() {
  if (!srcImage) { $('srcInfo').innerHTML = '<span>还没有选择图片。</span>'; return; }
  const mb = proj.source ? (proj.source.size / 1048576).toFixed(2) : '?';
  $('srcInfo').innerHTML =
    `文件：<b>${proj.srcName || '(未命名)'}</b><br>` +
    `尺寸：<b>${srcImage.width} × ${srcImage.height}</b>　大小：<b>${mb} MB</b>`;
}

// --------------------------------------------------------------- cutout ---

async function runCutout() {
  busy(true, '准备模型…');
  try {
    const { ort, session } = await ensureSession();
    const res = await M.cutout(ort, session, srcImage,
      { width: srcImage.width, height: srcImage.height },
      { onStage: s => busyText(STAGE_LABEL[s] || s) });

    charImage = cutoutToCanvas(res);
    proj.character = await canvasToBlob(charImage);
    stage.setCharacter(charImage);
    stage.image = charImage;

    const total = res.marks.reduce((a, m) => a + m.ms, 0);
    $('cutMarks').textContent = res.marks.map(m => `${m.stage.padEnd(14)}${m.ms.toFixed(0)}ms`).join('\n')
      + `\n${''.padEnd(14, '-')}\n${'合计'.padEnd(12)}${total.toFixed(0)}ms`;
    $('cutResult').hidden = false;

    setStep(3);
    await saveNow();
  } catch (e) {
    fatal(e);
  } finally {
    busy(false);
  }
}

// ---------------------------------------------------------- params panel ---

/** Global sliders only. The per-region ones are generated, further down. */
const sliders = {};   // key -> { el, out, sync, spec }
// (`regionUI` is declared at the top of the module -- see the note there.)

function buildParamPanel() {
  const host = $('paramGroups');
  host.innerHTML = '';
  const sec = document.createElement('div');
  sec.className = 'grp';
  sec.innerHTML = '<div class="title">整体</div>';
  for (const p of PARAMS) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label>${p.label}</label>`
      + `<input type="range" id="sl_${p.key}" min="${p.min}" max="${p.max}" step="${p.step}">`
      + `<span class="val" id="slv_${p.key}"></span>`;
    sec.appendChild(row);
  }
  host.appendChild(sec);

  for (const p of PARAMS) {
    const el = $(`sl_${p.key}`), out = $(`slv_${p.key}`);
    // The slider moves in its own units (zoom shows percent); proj.params keeps
    // the internal one, which is what the shader and the exporter both read.
    const sync = () => {
      const raw = parseFloat(el.value);
      proj.params[p.key] = raw * p.scale;
      out.textContent = raw.toFixed(p.dec) + p.unit;
    };
    el.addEventListener('input', () => { sync(); scheduleSave(); });
    sliders[p.key] = { el, out, sync, spec: p };
  }
}

function applyParams(params) {
  for (const key in sliders) {
    const s = sliders[key];
    s.el.value = params[key] / s.spec.scale;
    s.sync();
  }
}

// ------------------------------------------------------------ region list ---

/**
 * One block per body part: name, its bulk sliders, and its ellipse count.
 *
 * Generated rather than fixed markup because the number of parts is the user's
 * decision, and the build cannot know it. The sliders here are **bulk
 * assignment**: dragging one writes the same value into every ellipse of that
 * part. That is what the region's own amp/spd mean, and it is why the value is
 * stored on the region at all -- a part with a hundred ellipses still needs one
 * way to move them together.
 *
 * Per-ellipse values live in the inspector, and are what actually drives the
 * animation. Two ellipses that want different lags get them there.
 */
function buildRegionList() {
  const host = $('regionList');
  host.innerHTML = '';
  regionUI = [];

  for (const reg of stage.regions) {
    const el = document.createElement('div');
    el.className = 'rgn';
    el.innerHTML =
      '<div class="rhead">'
      + '<span class="dot"></span>'
      + '<input class="rname" maxlength="24" spellcheck="false">'
      + '<span class="rcount"></span>'
      + '<button class="ghost rdel" title="删除这个部位">删除</button>'
      + '</div>';

    const rows = {};
    for (const p of REGION_PARAMS) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<label>${p.label}</label>`
        + `<input type="range" min="${p.min}" max="${p.max}" step="${p.step}">`
        + '<span class="val"></span>';
      el.appendChild(row);
      rows[p.key] = { el: row.querySelector('input'), out: row.querySelector('.val') };
    }
    const btns = document.createElement('div');
    btns.className = 'btns';
    btns.innerHTML = '<button class="radd">＋椭圆</button>';
    el.appendChild(btns);
    host.appendChild(el);

    const ui = {
      reg, el, rows,
      name: el.querySelector('.rname'),
      count: el.querySelector('.rcount'),
      dot: el.querySelector('.dot'),
      add: el.querySelector('.radd'),
      del: el.querySelector('.rdel'),
    };
    regionUI.push(ui);

    ui.name.addEventListener('input', () => {
      // user text, never innerHTML -- and it is only ever drawn on the overlay
      // canvas, so there is no markup to escape in the first place
      reg.name = ui.name.value.trim().slice(0, 24) || '未命名部位';
      stage.drawOverlay();
      scheduleSave();
    });
    for (const p of REGION_PARAMS) {
      const r = ui.rows[p.key];
      r.el.addEventListener('input', () => {
        const v = parseFloat(r.el.value);
        reg[p.key] = v;
        for (const b of reg.blobs) b[p.key] = v;
        stage.afterEdit(reg);
      });
    }
    ui.add.addEventListener('click', () => addBlob(reg));
    ui.del.addEventListener('click', () => deleteRegion(reg));
  }
  syncRegionList();
}

/** data -> the region blocks. Called on every edit, never from the render loop. */
function syncRegionList() {
  for (const ui of regionUI) {
    const reg = ui.reg;
    // Never fight someone for the field they are typing into.
    if (document.activeElement !== ui.name) ui.name.value = reg.name;
    ui.dot.style.background = `rgb(${reg.color.join(',')})`;
    ui.count.textContent = `${reg.blobs.length} 个椭圆`;
    ui.el.classList.toggle('on', !!stage.sel && stage.sel.reg === reg);
    ui.el.classList.toggle('empty', !reg.blobs.length);
    for (const p of REGION_PARAMS) {
      const r = ui.rows[p.key];
      if (document.activeElement !== r.el) r.el.value = reg[p.key];
      r.out.textContent = (+reg[p.key]).toFixed(p.dec) + p.unit;
    }
  }
}

// ------------------------------------------------------------- inspector ---

const INS_FIELDS = ['ins_cx', 'ins_cy', 'ins_rx', 'ins_ry', 'ins_rot',
                    'ins_amp', 'ins_spd', 'ins_delay', 'ins_px', 'ins_py', 'ins_col', 'ins_name'];

/** Per-ellipse motion fields, by inspector id. */
const INS_BLOB_PARAM = {
  ins_amp: BLOB_PARAMS.find(p => p.key === 'amp'),
  ins_spd: BLOB_PARAMS.find(p => p.key === 'spd'),
  ins_delay: BLOB_PARAMS.find(p => p.key === 'delay'),
};

function setNum(id, v, force) {
  const el = $(id);
  // Never fight someone for the field they are typing into.
  if (force || document.activeElement !== el) el.value = +v.toFixed(4);
}
const hex2 = n => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
function setCol(id, col, force) {
  const el = $(id);
  if (force || document.activeElement !== el) el.value = '#' + col.slice(0, 3).map(hex2).join('');
}
function hexToRgb(hex, fallback) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * data -> widgets. Called on every edit, but never from the render loop.
 *
 * Shows for a pivot as well as for an ellipse: with several parts, the pivot is
 * its own thing to select -- that is how you move where a part turns from, and
 * how you rename it. The ellipse-only fields hide when no ellipse is selected.
 */
function syncInspector(force) {
  const sel = stage.sel;
  const reg = sel ? sel.reg : null;
  const b = sel && sel.kind === 'blob' ? sel.blob : null;

  $('inspector').hidden = !reg;
  $('insBlob').hidden = !b;

  if (reg) {
    const nameEl = $('ins_name');
    if (force || document.activeElement !== nameEl) nameEl.value = reg.name;
    setCol('ins_col', reg.color, force);
    setNum('ins_px', reg.pivot[0], force);
    setNum('ins_py', reg.pivot[1], force);
    if (b) {
      setNum('ins_cx', b.c[0], force); setNum('ins_cy', b.c[1], force);
      setNum('ins_rx', b.r[0], force); setNum('ins_ry', b.r[1], force);
      setNum('ins_rot', b.rot, force);
      setNum('ins_amp', b.amp, force);
      setNum('ins_spd', b.spd, force);
      setNum('ins_delay', b.delay, force);
    }
  }
  syncRegionList();

  // An empty part is legal -- it just means that part never moves. Say so, or
  // it reads as a broken control point instead of a deliberate one.
  const hint = $('insHint');
  const empty = stage.regions.filter(r => !r.blobs.length);
  if (empty.length) {
    hint.classList.add('warn');
    hint.textContent = `${empty.map(r => r.name).join('、')}还没有椭圆 —— 该部位会保持静止`;
  } else {
    hint.classList.remove('warn');
    hint.textContent = b
      ? `选中：${reg.name} · 椭圆 ${reg.blobs.indexOf(b) + 1}/${reg.blobs.length}`
      : '点击画面上的椭圆或红色枢轴点来编辑；把鼠标停在枢轴上会显示它属于哪个部位。';
  }
}

/**
 * widgets -> data, for one field.
 *
 * Only the field that fired is written back. Committing all of them would copy
 * the inspector's 4-decimal display over the untouched full-precision values, so
 * nudging the rotation would also round the centre to 0.1px. A half-typed "-"
 * or "0." parses as NaN and is skipped, so the value is never yanked out from
 * under someone mid-keystroke.
 */
function insCommit(id) {
  const sel = stage.sel;
  if (!sel) return;
  const reg = sel.reg;
  const b = sel.kind === 'blob' ? sel.blob : null;

  if (id === 'ins_name') {
    reg.name = $('ins_name').value.trim().slice(0, 24) || '未命名部位';
    stage.drawOverlay();
    syncRegionList();
    scheduleSave();
    return;
  }
  if (id === 'ins_col') {
    reg.color = hexToRgb($('ins_col').value, reg.color);
    stage.touch();
    syncRegionList();
    return;
  }
  const v = parseFloat($(id).value);
  if (isNaN(v)) return;
  const fit = (lo, hi) => Math.min(hi, Math.max(lo, v));

  // The pivot moves where the region turns about, not where its weight field
  // is -- so it needs no re-bake, only a redraw.
  if (id === 'ins_px' || id === 'ins_py') {
    if (id === 'ins_px') reg.pivot[0] = fit(-0.4, 1.4);
    else reg.pivot[1] = fit(-0.4, 1.4);
    stage.touch();
    return;
  }
  if (!b) return;
  else if (id === 'ins_cx') b.c[0] = fit(-0.4, 1.4);
  else if (id === 'ins_cy') b.c[1] = fit(-0.4, 1.4);
  else if (id === 'ins_rx') b.r[0] = fit(0.002, 0.9);
  else if (id === 'ins_ry') b.r[1] = fit(0.002, 0.9);
  else if (id === 'ins_rot') b.rot = normDeg(v);
  else {
    // amp / spd / delay -- clamped to the same table the sliders use, so a
    // typed value cannot leave the range the panel is willing to show.
    const spec = INS_BLOB_PARAM[id];
    if (!spec) return;
    b[spec.key] = fit(spec.min, spec.max);
  }
  // Everything past here moves an ellipse, so it moves the weight field. Only
  // this region's channels can have changed -- the bake is per-region -- so the
  // re-bake is scoped to it rather than to the whole project. That is what
  // keeps a drag smooth with several parts on screen.
  stage.afterEdit(reg);
}

// --------------------------------------------------------------- saving ---

let saveTimer = null;
function setSaveState(msg, bad) {
  const el = $('saveState');
  el.textContent = msg;
  el.classList.toggle('bad', !!bad);
}

function scheduleSave() {
  setSaveState('保存中…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveNow().catch(() => {}); }, 500);
}

async function saveNow() {
  clearTimeout(saveTimer);
  try {
    proj.updated = Date.now();
    await P.putProject({
      id: proj.id, name: proj.name, srcName: proj.srcName,
      created: proj.created, updated: proj.updated, step: proj.step,
      source: proj.source, character: proj.character,
      regions: proj.regions, params: proj.params, meta: proj.meta, thumb: proj.thumb,
    });
    await P.setKV('last', proj.id);
    setSaveState(`已保存 ${time()}`);
  } catch (e) {
    // Not fatal: the work is still on screen, only the safety net is missing.
    setSaveState(`无法自动保存（${e.name || e}）—— 请用「导出项目文件」手动备份`, true);
  }
}

/**
 * A debounced save still pending when the tab goes away is a lost edit.
 *
 * visibilitychange fires first and gives the IndexedDB write a chance to finish;
 * pagehide is the backstop for a close that skips it. Both are best-effort --
 * nothing is guaranteed to complete during unload -- but dropping the edit
 * silently is worse than trying.
 */
function flushSave() { if (saveTimer) saveNow().catch(() => {}); }
addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
addEventListener('pagehide', flushSave);

// --------------------------------------------------------------- export ---

/** Build the deliverable text without touching the DOM or the download. */
export async function renderDemoHtml() {
  if (!proj.character) throw new Error('还没有抠图，无法导出。');
  return buildDemo({
    name: proj.name,
    imageBase64: await blobToBase64(proj.character),
    regions: proj.regions,
    params: proj.params,
    meta: proj.meta,
  });
}

async function exportDemo() {
  if (!proj.character) return;
  busy(true, '生成 demo.html…');
  try {
    const r = await renderDemoHtml();
    const file = `${slug(proj.name)}-demo.html`;
    download(new Blob([r.html], { type: 'text/html' }), file);
    $('exportInfo').innerHTML =
      `已生成 <b>${file}</b>（${(r.bytes / 1e6).toFixed(2)} MB）<br>双击就能打开，不需要联网。` +
      (r.stale.length ? `<br>提示：_params 里有找不到滑块的键 ${r.stale.join(', ')}` : '');
  } catch (e) {
    fatal(e);
  } finally {
    busy(false);
  }
}

// ------------------------------------------------------------------ gif ---

/**
 * Render the finished animation to a looping GIF.
 *
 * Two passes over the same generator. The first renders a handful of frames
 * spread across the cycle and builds one global palette from all of them; the
 * second renders every frame and encodes. Sampling the palette from frame 0
 * alone would band on any colour that only appears at one extreme of the swing
 * -- a leg at the far end of its arc, say -- for the whole loop.
 *
 * Returns the bytes along with what was actually achieved, so the panel can
 * report real numbers instead of the ones that were asked for.
 */
async function renderGifBlob({ size, fps, seconds, bg, dither, onProgress }) {
  const plan = framePlan(fps, seconds);
  // The seam maths is per ellipse -- that is what a lag difference between two
  // ellipses in one region changes -- so it takes the flat channel list, in the
  // same order the shader reads them.
  const blobs = flatBlobs(proj.regions).blobs;
  const harm = proj.params.harm;
  // Which instant of the cycle to start recording at. Not an animation
  // parameter: nothing the user tuned changes, and the preview is untouched.
  const start = bestStartPhase(blobs, harm, plan.actualSeconds);

  const probes = Math.min(plan.n, 10);
  const probePhases = [];
  for (let i = 0; i < probes; i++) probePhases.push(start + i * plan.actualSeconds / probes);

  const total = probes + plan.n;
  let done = 0;
  const tick = () => { done++; onProgress?.(100 * done / total); };

  const sampled = [];
  for await (const f of stage.renderFrames({ width: size, height: size, phases: probePhases, bg })) {
    sampled.push(f);
    tick();
  }

  const bgRgb = bgColorOf(sampled[0], size, size, frameRect(size, size, fitZoom(proj.params.zoom)));
  const palette = samplePalette(sampled, bgRgb);

  const bytes = await encodeGif({
    width: size, height: size, palette, dither,
    frames: stage.renderFrames({
      width: size, height: size, phases: phasesFor(plan.n, plan.delayCs, start), bg,
    }),
    delayMs: plan.delayCs * 10,
    onProgress: tick,
  });

  // `start` is handed back so a test can re-render the identical frame and
  // compare it against what came out of the encoder.
  return { bytes, plan, bgRgb, start, seam: seamAt(blobs, harm, start, plan.actualSeconds) };
}

/** The export panel's settings. */
function gifOptions() {
  return {
    size: +$('gifSize').value,
    fps: +$('gifFps').value,
    seconds: +$('gifSec').value,
    bg: +$('gifBg').value,
    dither: $('gifDither').checked,
  };
}

async function exportGif() {
  if (!proj.character) return;
  const opts = gifOptions();
  const t0 = performance.now();
  busy(true, '渲染动图…');
  try {
    const r = await renderGifBlob({ ...opts, onProgress: busyProgress });
    const file = `${slug(proj.name)}.gif`;
    download(new Blob([r.bytes], { type: 'image/gif' }), file);

    // The seam is reported rather than asserted: with the default parameters it
    // lands at machine precision, but a head speed that does not divide the
    // duration cannot be zeroed by any single start phase, and pretending
    // otherwise would be the more misleading choice.
    const seam = r.seam.max < 0.01
      ? '无缝'
      : `${r.seam.max.toFixed(2)}°（约 ${(r.seam.max / 360 * opts.size * 2).toFixed(0)}px）`;
    // Zoom > 1 is where the preview stops showing the whole artwork -- it fills
    // the window past the square and the shader crops. A square GIF has no
    // window to hide that in, so it frames at 100% and says so, rather than
    // quietly handing back a crop of the character.
    const framed = proj.params.zoom > 1
      ? `<br>预览缩放 ${Math.round(proj.params.zoom * 100)}% 已超出画幅，动图按 100% 取景（保证画面完整）`
      : '';
    $('gifInfo').innerHTML =
      `已生成 <b>${file}</b>（${(r.bytes.length / 1e6).toFixed(2)} MB）<br>` +
      `${opts.size}px · ${opts.fps}fps · ${r.plan.n} 帧 · ${r.plan.actualSeconds.toFixed(2)} 秒<br>` +
      `循环接缝 ${seam} · 用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒` + framed;
  } catch (e) {
    fatal(e);
  } finally {
    busy(false);
  }
}

/** Populate the export panel once, at startup. */
function initGifPanel() {
  const fill = (el, values, label, sel) => {
    el.innerHTML = values.map(v => `<option value="${v}">${label(v)}</option>`).join('');
    el.value = String(sel);
  };
  fill($('gifSize'), GIF_SIZES, v => `${v} × ${v}`, 512);
  fill($('gifFps'), GIF_FPS, v => `${v} fps`, 10);
  fill($('gifSec'), GIF_SECONDS, v => `${v} 秒`, 5);
  // Dark and light only. The checkerboard exists to reveal transparency in the
  // editor; baked into a file someone is about to share it would just look like
  // a mistake, so it is not on the menu.
  $('gifBg').innerHTML = '<option value="2">浅色</option><option value="1">深色</option>';
  $('gifBg').value = String(stage.view.bg === 1 ? 1 : 2);
}

// ------------------------------------------------------- project storage ---

async function loadRecord(rec) {
  Object.assign(proj, {
    id: rec.id,
    name: rec.name || '未命名项目',
    srcName: rec.srcName || '',
    created: rec.created || Date.now(),
    updated: rec.updated || Date.now(),
    step: rec.step || 1,
    source: rec.source || null,
    character: rec.character || null,
    regions: normalizeRegions(rec.regions),
    params: sanitizeParams(rec.params),
    meta: rec.meta || { _comment: DEFAULT_COMMENT },
    thumb: rec.thumb || null,
  });
  $('projName').value = proj.name === '未命名项目' ? '' : proj.name;

  srcImage = proj.source ? await decodeImage(proj.source) : null;
  charImage = proj.character ? await decodeImage(proj.character) : null;
  if (charImage) stage.setCharacter(charImage);

  applyRegions(proj.regions);
  stage.params = proj.params;
  applyParams(proj.params);
  stage.image = charImage || srcImage;

  $('drop').classList.toggle('hide', !!srcImage);
  $('cutResult').hidden = !charImage;
  updateSrcInfo();
  updateGates();
  setStep(proj.step);
  setSaveState('已载入 · ' + time());
}

async function newProject() {
  Object.assign(proj, {
    id: P.newId(),
    name: '未命名项目',
    srcName: '',
    created: Date.now(),
    updated: Date.now(),
    step: 1,
    source: null,
    character: null,
    regions: defaultRegions(),
    params: defaultParams(),
    meta: { _comment: DEFAULT_COMMENT },
    thumb: null,
  });
  srcImage = null;
  charImage = null;
  $('projName').value = '';
  $('cutResult').hidden = true;
  $('exportInfo').innerHTML = '';
  applyRegions(proj.regions);
  stage.params = proj.params;
  applyParams(proj.params);
  stage.image = null;
  updateSrcInfo();
  setStep(1);
}

async function openProjectList() {
  const host = $('projList');
  $('modal').hidden = false;
  let list = [];
  try { list = await P.listProjects(); } catch (e) { fatal(e); }

  if (!list.length) {
    host.innerHTML = '<div class="empty">还没有保存过的项目</div>';
    return;
  }
  host.innerHTML = '';
  for (const item of list) {
    const row = document.createElement('div');
    row.className = 'pitem';
    row.dataset.id = item.id;
    row.innerHTML =
      `<img alt="" src="${item.thumb || 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='}">`
      + `<span class="meta"><b></b><span></span></span>`
      + `<button class="del ghost" data-del="${item.id}">删除</button>`;
    row.querySelector('b').textContent = item.name;   // user text, never innerHTML
    row.querySelector('.meta span').textContent =
      new Date(item.updated || 0).toLocaleString('zh-CN', { hour12: false })
      + (item.hasCut ? ' · 已抠图' : ' · 未抠图');
    host.appendChild(row);
  }
}

// ------------------------------------------------------------------ wire ---

function wire() {
  initGifPanel();

  // --- steps
  for (const el of $$('.step')) el.addEventListener('click', () => setStep(+el.dataset.step));
  for (const el of $$('[data-goto]')) el.addEventListener('click', () => setStep(+el.dataset.goto));

  // --- import
  $('btnPick').addEventListener('click', () => $('fileImg').click());
  $('fileImg').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) importSource(f).catch(fatal);
    e.target.value = '';   // so re-picking the same file fires again
  });
  $('toStep2').addEventListener('click', () => setStep(2));

  const drop = $('drop');
  const over = e => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    drop.classList.add('over');
    drop.classList.remove('hide');
  };
  addEventListener('dragover', over);
  addEventListener('dragenter', over);
  addEventListener('dragleave', e => {
    if (!e.relatedTarget) { drop.classList.remove('over'); drop.classList.toggle('hide', !!srcImage); }
  });
  addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('over');
    drop.classList.toggle('hide', !!srcImage);
    const f = e.dataTransfer?.files?.[0];
    if (f) importSource(f).catch(fatal);
  });
  addEventListener('paste', e => {
    const f = [...(e.clipboardData?.files || [])][0];
    if (f) importSource(f).catch(fatal);
  });

  // --- cutout
  $('btnCut').addEventListener('click', runCutout);
  $('btnCutAgain').addEventListener('click', runCutout);
  $('toStep3').addEventListener('click', () => setStep(3));

  // --- region editing
  $('bAddRegion').addEventListener('click', addRegion);
  $('bDup').addEventListener('click', duplicateBlob);
  $('bDel').addEventListener('click', deleteBlob);
  for (const id of INS_FIELDS) {
    const el = $(id);
    el.addEventListener('input', () => insCommit(id));
    // On Enter/blur, echo the clamped value back so the box shows what was kept.
    el.addEventListener('change', () => { insCommit(id); syncInspector(true); });
  }

  // --- view toggles
  const bPlay = $('bPlay');
  bPlay.addEventListener('click', () => {
    stage.view.playing = !stage.view.playing;
    bPlay.classList.toggle('on', stage.view.playing);
    bPlay.textContent = stage.view.playing ? '暂停' : '播放';
  });
  const bW = $('bW');
  bW.addEventListener('click', () => {
    stage.view.weights = !stage.view.weights;
    bW.classList.toggle('on', stage.view.weights);
  });
  const bG = $('bG');
  bG.addEventListener('click', () => {
    stage.view.guides = !stage.view.guides;
    bG.classList.toggle('on', stage.view.guides);
    stage.draw();
  });
  const bBg = $('bBg');
  bBg.addEventListener('click', () => {
    stage.view.bg = (stage.view.bg + 1) % 3;
    bBg.textContent = '背景:' + BG_NAMES[stage.view.bg];
  });
  addEventListener('keydown', e => {
    if (e.code === 'Space' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      e.preventDefault();
      bPlay.click();
    }
  });

  // --- reset
  $('btnReset').addEventListener('click', () => {
    proj.regions = defaultRegions();
    proj.params = defaultParams();
    applyRegions(proj.regions);
    applyParams(proj.params);
    stage.draw();
    scheduleSave();
  });

  // --- export
  $('btnExport').addEventListener('click', exportDemo);
  $('btnExportTop').addEventListener('click', exportDemo);
  $('btnGif').addEventListener('click', exportGif);
  $('btnRegions').addEventListener('click', () => {
    const text = regionsJson({ meta: proj.meta, params: proj.params, regions: proj.regions });
    download(new Blob([text], { type: 'application/json' }), 'regions.json');
  });
  $('btnSaveProj').addEventListener('click', async () => {
    try {
      const text = await P.exportProjectFile(proj);
      download(new Blob([text], { type: 'application/json' }), `${slug(proj.name)}.jd2d.json`);
    } catch (e) { fatal(e); }
  });
  $('btnLoadRegions').addEventListener('click', () => $('fileRegions').click());
  $('fileRegions').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      // The bridge back to the old workflow: regions.json files already living
      // in assets/<name>/ can be applied to whatever is open now.
      const { regions, params, meta } = parseRegionsJson(await f.text());
      proj.regions = normalizeRegions(regions);
      if (params) { proj.params = sanitizeParams(params); applyParams(proj.params); }
      if (meta) proj.meta = meta;
      applyRegions(proj.regions);
      stage.draw();
      await saveNow();
    } catch (err) { fatal(err); }
  });

  $('btnLoadProj').addEventListener('click', () => $('fileProj').click());
  $('fileProj').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const rec = P.importProjectFile(await f.text());
      await P.putProject(rec);
      await loadRecord(rec);
      await saveNow();
    } catch (err) { fatal(err); }
  });

  // --- project name
  $('projName').addEventListener('input', e => {
    proj.name = e.target.value.trim() || '未命名项目';
    scheduleSave();
  });

  // --- project list
  $('btnOpen').addEventListener('click', openProjectList);
  $('btnNew').addEventListener('click', async () => {
    await newProject();
    await saveNow();
  });
  $('modalClose').addEventListener('click', () => { $('modal').hidden = true; });
  $('modal').addEventListener('click', e => { if (e.target.id === 'modal') $('modal').hidden = true; });
  $('projList').addEventListener('click', async e => {
    const delId = e.target.dataset?.del;
    if (delId) {
      // A second click on the same button confirms -- window.confirm is blocked
      // in enough contexts that relying on it would strand the user.
      if (e.target.dataset.armed) {
        await P.deleteProject(delId);
        await openProjectList();
      } else {
        e.target.dataset.armed = '1';
        e.target.textContent = '确认删除';
      }
      return;
    }
    const row = e.target.closest('.pitem');
    if (!row) return;
    const rec = await P.getProject(row.dataset.id);
    if (!rec) return;
    $('modal').hidden = true;
    await loadRecord(rec);
    await P.setKV('last', rec.id);
  });
}

// ------------------------------------------------- region / blob edits ---

/**
 * Adding or removing an ellipse changes the channel layout, so these go through
 * `stage.rebuild()` rather than `afterEdit()`: every ellipse after the one that
 * moved shifts down a channel, and the weight textures have to be laid out
 * again. Dragging never does this -- only a discrete add or delete, which is a
 * click, not a frame.
 */

function addBlob(reg) {
  if (reg.blobs.length >= MAX_BLOBS) {
    fatal(new Error(`一个项目最多 ${MAX_BLOBS} 个椭圆（${MAX_BLOBS / 4} 张权重纹理加角色图，` +
      `正好用满 WebGL1 保证的 8 个纹理单元）。`));
    return;
  }
  // Anchor on the pivot: the one point in the region known to be on the body.
  const b = { c: [reg.pivot[0], reg.pivot[1]], r: [0.12, 0.12], rot: 0 };
  // Inherit the part's bulk values, so a new ellipse starts in step with the
  // ones already there instead of snapping to some global default. Lag has no
  // region-level counterpart -- a region lags through its ellipses -- so it
  // takes the spec's default rather than an undefined that would surface as a
  // blank inspector field and a NaN angle.
  for (const p of BLOB_PARAMS) b[p.key] = reg[p.key] ?? p.def;
  reg.blobs.push(b);
  stage.sel = { reg, blob: b, kind: 'blob' };
  stage.rebuild();
  syncInspector();
}

function duplicateBlob() {
  const sel = stage.sel;
  const b = sel && sel.kind === 'blob' ? sel.blob : null;
  if (!b) return;
  if (sel.reg.blobs.length >= MAX_BLOBS) {
    fatal(new Error(`一个项目最多 ${MAX_BLOBS} 个椭圆。`));
    return;
  }
  // Offset it, so the copy is visibly its own blob instead of hiding under the
  // original. Everything else is copied verbatim -- including the lag, which is
  // the point: duplicating a leg and then nudging its delay is how two limbs get
  // out of step.
  const copy = { c: [b.c[0] + 0.03, b.c[1] + 0.03], r: [b.r[0], b.r[1]], rot: b.rot };
  for (const p of BLOB_PARAMS) copy[p.key] = b[p.key];
  sel.reg.blobs.push(copy);
  stage.sel = { reg: sel.reg, blob: copy, kind: 'blob' };
  stage.rebuild();
  syncInspector();
}

function deleteBlob() {
  const sel = stage.sel;
  const b = sel && sel.kind === 'blob' ? sel.blob : null;
  if (!b) return;
  const reg = sel.reg;
  const arr = reg.blobs;
  const i = arr.indexOf(b);
  if (i < 0) { stage.sel = null; stage.rebuild(); syncInspector(); return; }
  arr.splice(i, 1);
  // Select whatever slid into this slot, so deleting several in a row needs no
  // re-click between them.
  stage.sel = arr.length
    ? { reg, blob: arr[Math.min(i, arr.length - 1)], kind: 'blob' }
    : { reg, blob: null, kind: 'pivot' };
  stage.rebuild();
  syncInspector();
}

/**
 * A new body part, with a pivot in the middle and no ellipses yet.
 *
 * Empty on purpose: the pivot is the one point the user has to place by hand,
 * and a starting ellipse under a default pivot would hide the fact that the
 * pivot is what makes the part turn.
 */
function addRegion() {
  const reg = {
    name: `部位 ${stage.regions.length + 1}`,
    pivot: [0.5, 0.5],
    color: regionColorAt(stage.regions.length),
    blobs: [],
  };
  for (const p of REGION_PARAMS) reg[p.key] = p.def;
  stage.regions.push(reg);
  stage.sel = { reg, blob: null, kind: 'pivot' };
  buildRegionList();
  stage.rebuild();
  syncInspector();
}

function deleteRegion(reg) {
  const i = stage.regions.indexOf(reg);
  if (i < 0) return;
  // One part is not a special case worth special-casing: with zero parts there
  // is nothing to select, nothing to add to, and the export has no pivots at
  // all. Refusing is clearer than a canvas that has stopped responding.
  if (stage.regions.length <= 1) {
    fatal(new Error('至少要保留一个部位 —— 用「重置本步」可以回到默认的三个。'));
    return;
  }
  stage.regions.splice(i, 1);
  if (stage.sel && stage.sel.reg === reg) stage.sel = null;
  buildRegionList();
  stage.rebuild();
  syncInspector();
}

// ------------------------------------------------------------------ boot ---

(async function boot() {
  buildParamPanel();
  wire();
  stage.start();

  // Paint before the async restore: a first-run user should see the drop zone,
  // not a black rectangle, while IndexedDB is being read.
  updateSrcInfo();
  setStep(1);

  try {
    const last = await P.getKV('last');
    const rec = last ? await P.getProject(last) : null;
    if (rec) {
      await loadRecord(rec);
      setSaveState('已恢复上次的项目');
    }
  } catch (e) {
    setSaveState('本地保存不可用 —— 请用「导出项目文件」备份', true);
  }
})();

/**
 * Test seams. app/test/ drives the real code through these over CDP rather than
 * reaching into the page with brittle selectors.
 *
 * __probe is the older, narrower surface app/test/matting.test.js uses to check
 * the matting port against Python's own numbers. It is kept separate because it
 * is about arithmetic, not about the interface.
 */
window.__probe = {
  // Deliberately not ensureSession(): the app loads the 168MB model lazily, and
  // merely opening the page should not start that. This resolves once we know
  // which backends exist, which is all the test needs before asking for numbers.
  ready: detectProviders(),
  providers: () => providerList || [],
  compareTensor: async () => parity.compareTensor(await ensureSession()),
  runPipeline: async () => parity.runPipeline(await ensureSession()),
};

window.__app = {
  ready: true,
  proj,
  stage,
  getStep: () => step,
  setStep,
  importBlob: (blob, name) =>
    importSource(new File([blob], name || 'test.png', { type: blob.type || 'image/png' })),
  cutout: () => runCutout(),
  renderDemoHtml,
  renderGifBlob,
  gifOptions,
  buildDemo,
  // Region-level edits take the region object itself. Names are user-editable
  // and may repeat, so there is no key to look one up by -- a caller in a test
  // has the project in front of it and can index the list.
  addBlob,
  addRegion,
  deleteRegion,
  applyRegions,
  fatal,
};
