/*
 * Can a file:// page write back to disk? Checks the File System Access API,
 * which is the only in-browser route to overwriting regions.json in place.
 *   node probe_fs.js
 */
const { spawn } = require("child_process");
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9344;
const PROFILE = path.join(os.tmpdir(), "probe-" + Date.now());
const PAGE = "file:///D:/coding/dev/nova/art/build/demo.html";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = u => new Promise((res, rej) =>
  http.get(u, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => res(d)); }).on("error", rej));

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    "--headless=new", "--enable-unsafe-swiftshader", "--allow-file-access-from-files",
    "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "about:blank",
  ], { stdio: "ignore" });

  let list = [];
  for (let i = 0; i < 80 && !list.length; i++) {
    try { list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`)).filter(t => t.type === "page"); } catch (_) {}
    if (!list.length) await sleep(200);
  }
  if (!list.length) { console.log("no debugger"); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  const pend = new Map();
  let seq = 0;
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params = {}) => new Promise(res => {
    const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async expr => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return "THREW: " + (r.result.exceptionDetails.exception?.description || "?");
    return r.result?.result?.value;
  };

  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: PAGE });
  await sleep(3000);

  console.log("secure context      :", await ev("isSecureContext"));
  console.log("origin              :", await ev("location.origin"));
  console.log("indexedDB           :", await ev("typeof indexedDB"));
  console.log("");
  console.log("showSaveFilePicker  :", await ev("typeof window.showSaveFilePicker"));
  console.log("showOpenFilePicker  :", await ev("typeof window.showOpenFilePicker"));
  console.log("showDirectoryPicker :", await ev("typeof window.showDirectoryPicker"));
  console.log("");
  // Calling without a user gesture: the error name tells us whether the API is
  // merely gesture-gated (usable) or outright blocked on this origin.
  console.log("call w/o gesture    :",
    await ev("(async()=>{try{await window.showSaveFilePicker();return 'RESOLVED';}catch(e){return e.name+' :: '+e.message;}})()"));

  ws.close(); chrome.kill(); await sleep(300); fs.rmSync(PROFILE, { recursive: true, force: true });
})().catch(e => { console.error("harness error:", e.message); process.exit(2); });
