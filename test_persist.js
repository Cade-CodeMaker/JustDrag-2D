/*
 * End-to-end check that in-browser edits survive a reload.
 * Drives the real page over the DevTools protocol with synthetic mouse input,
 * so it exercises the actual pointer handlers rather than calling internals.
 *
 *   node test_persist.js
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9333;
const PROFILE = path.join(os.tmpdir(), "nova-cdp-profile-" + Date.now());
const URL = "file:///D:/coding/dev/nova/art/build/demo.html";
const KEY = "nova-art-deform-v1";

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
  await send("Page.navigate", { url: URL });
  await sleep(3000);

  console.log("\n1. clean profile — nothing stored yet");
  check("localStorage starts empty", (await evalJS(`localStorage.getItem(${JSON.stringify(KEY)})`)) === null);
  check("page rendered", (await evalJS(`document.querySelectorAll('#diag').length && document.getElementById('diag').style.display !== 'block'`)) === true);
  const before = await evalJS(`JSON.stringify(regions.head.blobs[0].c)`);
  console.log("     head blob starts at " + before);

  console.log("\n2. drag the head control point (real mouse input)");
  const [sx, sy] = [120 + 0.78 * 900, 0.36 * 900];   // blob centre in viewport px
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
  const after = await evalJS(`JSON.stringify(regions.head.blobs[0].c)`);
  console.log("     head blob moved to " + after);
  check("stored blob matches the live one",
    parsed && JSON.stringify(parsed.regions.head.blobs[0].c) === after, after);

  console.log("\n3. change a slider");
  await evalJS(`(()=>{const e=document.getElementById('hAmp');e.value='9.5';e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(400);
  const p2 = JSON.parse(await evalJS(`localStorage.getItem(${JSON.stringify(KEY)})`));
  check("slider value persisted", p2 && p2.params && p2.params.hAmp === 9.5, "hAmp=" + (p2?.params?.hAmp));

  console.log("\n4. reload — does it come back?");
  await send("Page.reload", { ignoreCache: true });
  await sleep(3000);
  const afterReload = await evalJS(`JSON.stringify(regions.head.blobs[0].c)`);
  const ampReload = await evalJS(`document.getElementById('hAmp').value`);
  check("blob position restored", afterReload === after, afterReload);
  check("slider restored", parseFloat(ampReload) === 9.5, "hAmp slider=" + ampReload);
  check("status line reports the restore",
    /恢复/.test(await evalJS(`document.getElementById('save').textContent`)),
    await evalJS(`document.getElementById('save').textContent`));

  console.log("\n5. reset clears storage");
  await evalJS(`document.getElementById('bRst').click()`);
  await sleep(300);
  check("storage cleared", (await evalJS(`localStorage.getItem(${JSON.stringify(KEY)})`)) === null);
  check("blob back to build default", (await evalJS(`JSON.stringify(regions.head.blobs[0].c)`)) === before);

  console.log("\n6. export produces pasteable regions.json");
  await evalJS(`document.getElementById('bExp').click()`);
  await sleep(200);
  const ex = await evalJS(`document.getElementById('out').value`);
  let exOK = false, exKeys = "";
  try { const o = JSON.parse(ex); exOK = !!(o.head?.blobs && o.legs?.blobs && o._params); exKeys = Object.keys(o).join(","); } catch (_) {}
  check("export is valid JSON with _params + regions", exOK, exKeys);

  console.log("\n7. every slider label agrees with its value");
  const labels = await evalJS(`(()=>{const o={};for(const k of PERSIST)o[k]=[document.getElementById(k).value,
    document.getElementById(k+'V').textContent, S[k]];return JSON.stringify(o);})()`);
  for (const [k, [raw, text, val]] of Object.entries(JSON.parse(labels))) {
    const expected = k === "zoom" ? (+raw).toFixed(0) + "%" : null;
    const ok = expected === null ? !/NaN|undefined/.test(text) : text === expected;
    check(`${k}: slider=${raw} label="${text}" S=${val}`, ok && !/NaN/.test(text + val));
  }
  check("zoom scale is a factor, not percent", (await evalJS(`S.zoom`)) === 1, "S.zoom=" + await evalJS(`S.zoom`));

  ws.close(); chrome.kill();
  await sleep(300);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  console.log(fails ? `\n${fails} CHECK(S) FAILED\n` : "\nall checks passed\n");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("harness error:", e); process.exit(2); });
