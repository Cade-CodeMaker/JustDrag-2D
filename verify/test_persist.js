/*
 * End-to-end check that in-browser edits survive a reload.
 * Drives the real page over the DevTools protocol with synthetic mouse input,
 * so it exercises the actual pointer handlers rather than calling internals.
 *
 * What the shipped demo can edit is deliberately small: a pivot drag and a
 * per-region bulk slider. Ellipse geometry lives in the editor (app/), so the
 * add/duplicate/delete and inspector sections this file used to carry have no
 * controls to drive here -- app/test/ui.test.js covers them against the real
 * page. What is left is what the deliverable actually ships, plus the two
 * invariants that come with the new layout: a pivot drag must not rebuild the
 * weight field, and a bulk slider must reach every ellipse of its region.
 *
 *   node verify/test_persist.js [name]        (default: sample)
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const ASSET = process.argv[2] || "sample";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9333;
const PROFILE = path.join(os.tmpdir(), "jutdrag-cdp-profile-" + Date.now());
// Resolved against this script's own location, so the test follows the repo
// instead of a hardcoded absolute path that silently tests the wrong build.
const PAGE_URL = pathToFileURL(
  path.join(__dirname, "..", "assets", ASSET, "out", "demo.html")).href;
const KEY = `nova-art-deform-${ASSET}-v1`;   // must match LS_KEY in tools/template.html

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = url => new Promise((res, rej) =>
  http.get(url, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => res(d)); }).on("error", rej));

let fails = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail !== undefined ? "   -> " + detail : ""}`);
  if (!ok) fails++;
}

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    "--headless=new", "--enable-unsafe-swiftshader", "--hide-scrollbars",
    "--allow-file-access-from-files", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    "--window-size=1440,900", "about:blank",
  ], { stdio: "ignore" });

  let list = [];
  for (let i = 0; i < 100 && !list.length; i++) {
    try { list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`)).filter(t => t.type === "page"); } catch (_) {}
    if (!list.length) await sleep(200);
  }
  if (!list.length) { console.log("could not reach the debugger"); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
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
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: PAGE_URL });
  await sleep(3000);

  console.log("\n1. clean profile — nothing stored yet");
  check("localStorage starts empty", (await evalJS(`localStorage.getItem(${JSON.stringify(KEY)})`)) === null);
  check("page rendered", (await evalJS(`document.querySelectorAll('#diag').length && document.getElementById('diag').style.display !== 'block'`)) === true);
  const before = await evalJS(`JSON.stringify(regions[0].pivot)`);
  console.log("     region 0 pivot starts at " + before);

  console.log("\n2. drag a pivot (real mouse input)");
  // Ask the page where the pivot actually is. A hardcoded viewport point only
  // landed on it for one asset at one window size.
  const [sx, sy] = await evalJS(`(() => {
    const p = regions[0].pivot;
    const r = document.getElementById('gl').getBoundingClientRect();
    const [x, y] = toScreen(p[0], p[1]);
    return [x + r.left, y + r.top];
  })()`);
  console.log(`     dragging from ${sx.toFixed(0)},${sy.toFixed(0)}`);
  const others = await evalJS(`JSON.stringify(regions.slice(1).map(r => r.pivot))`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: sx, y: sy, button: "left", clickCount: 1, buttons: 1 });
  for (const [x, y] of [[sx - 20, sy - 12], [sx - 34, sy - 21], [sx - 42, sy - 26]]) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await sleep(60);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: sx - 42, y: sy - 26, button: "left", clickCount: 1, buttons: 0 });
  await sleep(500);

  const stored = await evalJS(`localStorage.getItem(${JSON.stringify(KEY)})`);
  check("a save was written", !!stored);
  const parsed = stored ? JSON.parse(stored) : null;
  check("the save is in the new shape",
    !!parsed && parsed.v === 2 && Array.isArray(parsed.regions)
      && JSON.stringify(Object.keys(parsed.params)) === `["harm","zoom"]`,
    parsed ? "v=" + parsed.v + " params=" + Object.keys(parsed.params).join(",") : "");
  const after = await evalJS(`JSON.stringify(regions[0].pivot)`);
  console.log("     region 0 pivot moved to " + after);
  // The reverse-iterating hit test means a drag inside another pivot's radius
  // would grab that one instead; catching it here beats debugging a lost edit.
  check("the drag moved the pivot it grabbed, and only that one",
    after !== before && (await evalJS(`JSON.stringify(regions.slice(1).map(r => r.pivot))`)) === others,
    after);
  check("stored pivot matches the live one",
    !!parsed && JSON.stringify(parsed.regions[0].pivot) === after, after);

  console.log("\n3. change a per-region bulk slider");
  // No ids: the region blocks are generated from the project's region list, so
  // they are addressed by position. Row 0 of block 0 is the first spec in
  // REGION_SLIDERS -- amplitude.
  await evalJS(`(()=>{const e=document.querySelector('#regionSliders .grp:nth-child(1) input[type=range]');
    e.value='9.5';e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(400);
  const p2 = JSON.parse(await evalJS(`localStorage.getItem(${JSON.stringify(KEY)})`));
  check("the region's own value persisted", p2 && p2.regions[0].amp === 9.5, "amp=" + (p2?.regions?.[0]?.amp));

  console.log("\n4. reload — does it come back?");
  await send("Page.reload", { ignoreCache: true });
  await sleep(3000);
  const afterReload = await evalJS(`JSON.stringify(regions[0].pivot)`);
  check("pivot restored", afterReload === after, afterReload);
  check("bulk value restored into the region and every ellipse",
    (await evalJS(`regions[0].amp === 9.5 && regions[0].blobs.every(b => b.amp === 9.5)`)) === true,
    "amp=" + await evalJS(`regions[0].amp`));
  check("the generated slider shows the restored value",
    parseFloat(await evalJS(
      `document.querySelector('#regionSliders .grp:nth-child(1) input[type=range]').value`)) === 9.5);
  check("status line reports the restore",
    /恢复/.test(await evalJS(`document.getElementById('save').textContent`)),
    await evalJS(`document.getElementById('save').textContent`));

  console.log("\n5. reset clears storage");
  await evalJS(`document.getElementById('bRst').click()`);
  await sleep(300);
  check("storage cleared", (await evalJS(`localStorage.getItem(${JSON.stringify(KEY)})`)) === null);
  check("pivot back to build default", (await evalJS(`JSON.stringify(regions[0].pivot)`)) === before);

  console.log("\n6. export produces pasteable regions.json");
  await evalJS(`document.getElementById('bExp').click()`);
  await sleep(200);
  const ex = await evalJS(`document.getElementById('out').value`);
  let exOK = false, exKeys = "";
  try {
    const o = JSON.parse(ex);
    exOK = Array.isArray(o.regions) && o.regions.length > 0
      && o.regions.every(r => Array.isArray(r.blobs) && Array.isArray(r.pivot)) && !!o._params;
    exKeys = Object.keys(o).join(",");
  } catch (_) {}
  check("export is valid JSON with _params + a regions list", exOK, exKeys);

  console.log("\n7. every slider label agrees with its value");
  const labels = await evalJS(`(()=>{const o={};for(const k of PERSIST)o[k]=[document.getElementById(k).value,
    document.getElementById(k+'V').textContent, S[k]];return JSON.stringify(o);})()`);
  for (const [k, [raw, text, val]] of Object.entries(JSON.parse(labels))) {
    const expected = k === "zoom" ? (+raw).toFixed(0) + "%" : null;
    const ok = expected === null ? !/NaN|undefined/.test(text) : text === expected;
    check(`${k}: slider=${raw} label="${text}" S=${val}`, ok && !/NaN/.test(text + val));
  }
  check("zoom scale is a factor, not percent", (await evalJS(`S.zoom`)) === 1, "S.zoom=" + await evalJS(`S.zoom`));

  // The region sliders are built from the project, not from the markup, so
  // their labels have no static markup to be checked against -- and a region
  // name is user text, which is why it goes in through textContent.
  const gen = JSON.parse(await evalJS(`JSON.stringify([...document.querySelectorAll('#regionSliders .grp')]
    .map(g => [g.querySelector('.title').textContent,
               [...g.querySelectorAll('.row')].map(r => r.querySelector('.val').textContent)]))`));
  const names = await evalJS(`JSON.stringify(regions.map(r => r.name))`);
  check("每个部位一组、组内两条滑块，标签都不是 NaN",
    gen.length === (await evalJS(`regions.length`)) && gen.every(([, vs]) => vs.length === 2
      && vs.every(v => v && !/NaN|undefined/.test(v))),
    JSON.stringify(gen.slice(0, 2)));
  check("标题就是部位名",
    gen.every(([n], i) => n === JSON.parse(names)[i]), names);

  // hash of the whole weight field -- any geometry change moves it
  const wHash = `(() => { const d = DeformCore.rasterize(regions, 256);
    let h = 0; for (let i = 0; i < d.length; i++) h = (h * 31 + d[i]) >>> 0; return h; })()`;

  console.log("\n8. a pivot drag is a uniform, not a rebuild");
  // Freeze the phase, so any pixel change between the two grabs is the drag's
  // doing and not the animation's.
  await evalJS(`document.getElementById('bPlay').click()`);
  await sleep(150);
  const wBefore = await evalJS(wHash);
  const grab = `new Promise(res => {
    const c = document.getElementById('gl');
    const gl = c.getContext('webgl');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const px = new Uint8Array(4 * c.width * c.height);
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let h = 0; for (let i = 0; i < px.length; i += 4) h = (h * 31 + px[i]) >>> 0;
      res(h);
    }));
  })`;
  const frameA = await evalJS(grab);
  const [px0, py0] = await evalJS(`(() => {
    const p = regions[0].pivot;
    const r = document.getElementById('gl').getBoundingClientRect();
    const [x, y] = toScreen(p[0], p[1]);
    return [x + r.left, y + r.top];
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: px0, y: py0, button: "left", clickCount: 1, buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px0 + 30, y: py0 - 18, button: "left", buttons: 1 });
  await sleep(90);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px0 + 30, y: py0 - 18, button: "left", clickCount: 1, buttons: 0 });
  await sleep(250);
  const frameB = await evalJS(grab);
  check("the drag moved the pivot and repainted", frameA !== frameB, `${frameA} -> ${frameB}`);
  // The field depends on the ellipses' centres, radii and rotations, and a pivot
  // is none of those -- it is read from a uniform every frame. Re-baking 65536
  // pixels per pointermove would be pure waste, so this asserts it does not.
  check("the weight field was not rebuilt", (await evalJS(wHash)) === wBefore, "hash " + wBefore);

  console.log("\n9. the bulk slider reaches every ellipse, and only its own region");
  const blocks = await evalJS(`document.querySelectorAll('#regionSliders .grp').length`);
  check("one block per region", blocks === (await evalJS(`regions.length`)), `${blocks} blocks`);
  const nBlobs = await evalJS(`DeformCore.flatBlobs(regions).blobs.length`);
  // One channel per ellipse, four to an RGBA texture -- the cap the shader
  // variant is compiled for is ceil(n/4), not the region count.
  const want = Math.ceil(nBlobs / 4) * 256 * 256 * 4;
  check("权重场是一个椭圆一条通道",
    (await evalJS(`DeformCore.rasterize(regions, 256).length`)) === want,
    `${nBlobs} 椭圆 -> ${want / (256 * 256 * 4)} 张纹理`);

  const otherRegion = await evalJS(`JSON.stringify(regions[0].blobs.map(b => b.spd))`);
  await evalJS(`(() => { const g = document.querySelectorAll('#regionSliders .grp')[1];
    const e = g.querySelectorAll('input[type=range]')[1];   // row 1 of REGION_SLIDERS is speed
    e.value = '2.4'; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(250);
  check("批量赋值写进了该部位的每一个椭圆",
    (await evalJS(`regions[1].spd === 2.4 && regions[1].blobs.length > 0`
      + ` && regions[1].blobs.every(b => b.spd === 2.4)`)) === true,
    `regions[1].spd=${await evalJS(`regions[1].spd`)}`);
  check("没有碰到别的部位",
    (await evalJS(`JSON.stringify(regions[0].blobs.map(b => b.spd))`)) === otherRegion);

  console.log("\n10. save writes regions.json through the picker");
  await evalJS(`window.__saved = null;
    window.showSaveFilePicker = async () => ({ name: 'regions.json',
      createWritable: async () => ({ write: async t => { window.__saved = t; },
                                     close: async () => {} }) });
    true`);
  await evalJS(`document.getElementById('bSave').click()`);
  await sleep(700);
  const savedText = await evalJS(`window.__saved`);
  let so = null;
  try { so = JSON.parse(savedText); } catch (_) { /* asserted below */ }
  check("the picker received a JSON document", !!so && typeof savedText === "string");
  check("it carries _params + a regions list",
    !!(so && so._params && Array.isArray(so.regions) && so.regions.length
      && so.regions.every(r => Array.isArray(r.blobs))));
  check("_params keys match PERSIST exactly",
    !!so && JSON.stringify(Object.keys(so._params)) === await evalJS(`JSON.stringify(PERSIST)`),
    so ? Object.keys(so._params).join(",") : "");
  check("region values are carried through unrounded",
    !!so && JSON.stringify(so.regions) === await evalJS(`JSON.stringify(regions)`));
  // Per-ellipse lag is what lets two legs swing out of step, so it has to
  // survive the write -- a dropped `delay` would silently re-sync them.
  check("每个椭圆的滞后写进去了",
    !!so && await evalJS(`regions.every(r => r.blobs.every(b => typeof b.delay === 'number'))`)
      && JSON.stringify(so.regions.map(r => r.blobs.map(b => b.delay)))
         === await evalJS(`JSON.stringify(regions.map(r => r.blobs.map(b => b.delay)))`));
  check("_comment round-trips from the build metadata",
    !!so && so._comment === await evalJS(
      `Object.prototype.hasOwnProperty.call(META, '_comment') ? META._comment : DEFAULT_COMMENT`),
    so ? JSON.stringify(so._comment) : "");
  check("the save button drops its dirty dot",
    (await evalJS(`!document.getElementById('bSave').classList.contains('dirty')`)) === true);
  check("the status line names the file it wrote",
    /regions\.json/.test(await evalJS(`document.getElementById('save').textContent`)),
    await evalJS(`document.getElementById('save').textContent`));

  console.log("\n11. no File System Access API — falls back to export");
  await evalJS(`window.showSaveFilePicker = undefined; cachedHandle = null;
    document.getElementById('out').value = ''; true`);
  await evalJS(`document.getElementById('bSave').click()`);
  await sleep(500);
  const fbText = await evalJS(`document.getElementById('out').value`);
  let fbo = null;
  try { fbo = JSON.parse(fbText); } catch (_) { /* asserted below */ }
  check("the export box is shown with a parseable config",
    (await evalJS(`document.getElementById('out').style.display`)) === "block"
      && !!fbo && Array.isArray(fbo.regions) && !!fbo.regions[0]?.blobs);
  check("the fallback says why it fell back",
    /不支持|导出/.test(await evalJS(`document.getElementById('save').textContent`)),
    await evalJS(`document.getElementById('save').textContent`));

  ws.close(); chrome.kill();
  await sleep(300);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  console.log(fails ? `\n${fails} CHECK(S) FAILED\n` : "\nall checks passed\n");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("harness error:", e); process.exit(2); });
