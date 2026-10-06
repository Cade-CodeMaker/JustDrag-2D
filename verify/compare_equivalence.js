/*
 * Does the ellipse-per-channel refactor still draw what the shipped demo drew?
 *
 *   node verify/compare_equivalence.js [name] [--perturb]
 *
 * compare_golden.js compares the weight texture byte for byte, and the whole
 * point of this refactor is that the weight texture changes shape: one channel
 * per *ellipse* instead of one per region. So that harness goes red on the
 * first honest step, exactly when it is needed, and stops being a signal. This
 * one compares what a viewer actually sees, and checks the weight change
 * against the bound it is supposed to respect rather than against zero.
 *
 * The checks, in increasing order of how much they assume:
 *
 *   1. the invariant, exactly. Baking k_r = M_r / S_r once per region makes
 *      sum_{i in r} w'_i equal the region's old single-channel value. Quantised
 *      to bytes it can only fall short, by at most (n_r - 1) LSB, because each
 *      of the n_r terms is truncated separately. Asserted per pixel, both
 *      directions -- see the derivation in DESIGN.
 *
 *   2. a one-ellipse region is bit-identical, not merely close. With n_r = 1
 *      the factor is M/S = w/w = 1.0 exactly in IEEE, so the deficit is
 *      identically zero. The sample's head region is a single ellipse, which
 *      makes this an exact check on real data rather than a synthetic case.
 *
 *   3. the rendered frame, against a tolerance measured on the same image
 *      rather than picked. A weight deficit is a sub-pixel error in the
 *      sampling coordinate, and what a sub-pixel error costs depends on the
 *      picture's own gradients -- a hard edge turns a hundredth of a pixel into
 *      several levels. So the harness pays for the same image a deliberate
 *      half-pixel shift and requires the refactor's difference to be smaller
 *      than that. It is not a derivation; it is a yardstick from the data, and
 *      it fails exactly when the render is as wrong as a mis-mapped channel.
 *      (The exact per-pixel check is #1 -- this one only has to catch a
 *      renderer that reads a correct field incorrectly.)
 *
 * Two negative controls, because they answer different questions.
 *
 * --perturb nudges the baseline's first ellipse radius by 1/255 and rebuilds.
 * That moves the falloff across thousands of pixels, so it asks "is the harness
 * awake?" -- a harness that does not notice it is not measuring anything. Same
 * discipline that pinned down the GIF crop bug.
 *
 * --inject pokes one weight byte -- one pixel, one channel, +1 LSB -- in the
 * one-ellipse region, where the budget is zero. That asks the sharper question:
 * can the invariant check resolve the smallest change the layout can represent,
 * or is it merely agreeing with itself? It should fail, and only on the
 * one-ellipse checks, and the render comparison should *not* notice -- a single
 * LSB in a single pixel is not a visible change, and a frame check that claimed
 * otherwise would be measuring noise.
 *
 * demo.baseline.html is the build from before the refactor -- old per-region
 * channel layout, old regions.json shape, both self-contained in the file. It
 * is the frozen "before" and must not be rebuilt.
 *
 * While both pages are still pre-refactor this degenerates to a byte-for-byte
 * weight comparison, which passes trivially. That is deliberate: it proves the
 * plumbing reads real pixels before the refactor makes the real check matter.
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const REPO = path.join(__dirname, "..");
const NAME = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "sample";
const PERTURB = process.argv.includes("--perturb");
const INJECT = process.argv.includes("--inject");
const OUT = path.join(REPO, "assets", NAME, "out");
const WS = 256;

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9336;
const PHASE = 0.37;

/**
 * The config the shipped demo was tuned to, stated once and applied to
 * whichever parameter shape the page being talked to happens to have. The old
 * build reads S.hAmp/hSpd/lAmp/lSpd/phase; the new one reads each ellipse's own
 * amp/spd/delay. Same numbers either way, so the only difference between the
 * two pages is the code under test.
 *
 * `n` is the ellipse count per region, which fixes the deficit budget: n_r
 * separately truncated terms can fall short by at most n_r - 1, so the head
 * (one ellipse) is budgeted 0 and the legs (three) are budgeted 2.
 */
const CONFIG = {
  harm: 0.22, zoom: 1,
  regions: [
    { amp: 3.5, spd: 1.00, delay: 0.0, n: 1 },   // head
    { amp: 4.5, spd: 0.85, delay: 0.5, n: 3 },   // legs
  ],
};

const BUDGET = CONFIG.regions.map(r => Math.max(0, r.n - 1));   // [0, 2]
const TOTAL = CONFIG.regions.reduce((s, r) => s + r.n, 0);      // 4 -- one texture

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = url => new Promise((res, rej) =>
  http.get(url, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => res(d)); }).on("error", rej));

/** Pin every parameter, and report which parameter shape this page has. */
const pinScript = () => `(() => {
  const C = ${JSON.stringify(CONFIG)};
  S.harm = C.harm; S.zoom = C.zoom;
  S.playing = false; S.bg = 0; S.weights = false; S.guides = false;
  let shape;
  if ("hAmp" in S) {
    shape = "old";
    S.hAmp = C.regions[0].amp; S.hSpd = C.regions[0].spd;
    S.lAmp = C.regions[1].amp; S.lSpd = C.regions[1].spd;
    S.phase = C.regions[1].delay;
  } else {
    shape = "new";
    const regs = Array.isArray(regions) ? regions : Object.values(regions);
    regs.forEach((r, i) => {
      const c = C.regions[i]; if (!c) return;
      r.amp = c.amp; r.spd = c.spd;
      for (const b of r.blobs) { b.amp = c.amp; b.spd = c.spd; b.delay = c.delay; }
    });
  }
  if (typeof buildWeights === "function") buildWeights();
  phaseT = ${PHASE};
  return shape;
})()`;

/**
 * The smallest edit the weight map can represent: one ellipse's radius by one
 * LSB. Applied to the baseline, so any failure it causes is the harness seeing
 * a difference it was always supposed to be looking for.
 */
const PERTURB_SCRIPT = `(() => {
  const first = Array.isArray(regions) ? regions[0] : regions.head;
  first.blobs[0].r[0] += 1/255;
  buildWeights();
  return first.blobs[0].r[0];
})()`;

/**
 * The `b64` helper both probes need. Inlined as source because it has to exist
 * inside the page, not here.
 */
const B64 = `const b64 = a => { let s = "";
  for (let i = 0; i < a.length; i += 8192)
    s += String.fromCharCode.apply(null, a.subarray(i, i + 8192));
  return btoa(s); };`;

const READ_PX = `const px = new Uint8Array(glc.width * glc.height * 4);
  gl.readPixels(0, 0, glc.width, glc.height, gl.RGBA, gl.UNSIGNED_BYTE, px);`;

/** Read the rendered frame and whatever this build calls its weight map. */
const probeScript = () => `(() => {
  draw(performance.now());
  ${READ_PX}
  ${B64}
  const wd = window.__wd
    || (typeof wData !== "undefined" ? wData : DeformCore.rasterize(regions, ${WS}));
  return { px: b64(px), wd: b64(wd) };
})()`;

/**
 * The sharpest negative control this layout admits: one weight byte, one pixel,
 * one LSB.
 *
 * --perturb moves an ellipse's radius, which shifts the falloff across thousands
 * of pixels and moves whole channels by 11 LSB -- far coarser than the quantity
 * the invariant check exists to resolve. So it proves the plumbing reads real
 * pixels, not that the check can see the thing it is measuring. This pokes a
 * single byte in a **one-ellipse** region, where the budget is zero and the
 * check therefore has to notice a change of exactly 1. It is the difference
 * between "the harness is awake" and "the harness is calibrated".
 */
const injectScript = px => `(() => {
  const d = DeformCore.rasterize(regions, ${WS});
  d[${px * 4}] += 1;                       // ellipse 0, red channel, one pixel
  window.__wd = d;                         // probeScript reports what was uploaded
  gl.activeTexture(gl.TEXTURE1);           // unit 1 is the first weight texture
  gl.bindTexture(gl.TEXTURE_2D, texW[0]);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ${WS}, ${WS}, gl.RGBA, gl.UNSIGNED_BYTE,
    d.subarray(0, ${WS * WS * 4}));
  gl.activeTexture(gl.TEXTURE0);
  return d[${px * 4}];
})()`;

/**
 * What half a pixel of misalignment costs on this very picture.
 *
 * Every pivot moves by the same half pixel, so the whole image is sampled half
 * a pixel off -- the same kind of error the weight deficit makes, at a size
 * that is unambiguously visible. Measured here rather than assumed, because the
 * cost of a sub-pixel shift is the picture's own edge contrast, and a number
 * picked off a chart would be wrong for the next asset.
 */
const YARDSTICK_SCRIPT = `(() => {
  const q = square();
  const dx = 0.5 / q.side;                 // half a pixel, in normalized units
  const keep = regions.map(r => r.pivot.slice());
  for (const r of regions) r.pivot[0] += dx;
  draw(performance.now());
  ${READ_PX}
  regions.forEach((r, i) => { r.pivot = keep[i]; });
  draw(performance.now());
  ${B64}
  return b64(px);
})()`;

/**
 * Byte index of flat ellipse channel `i` in the concatenated weight buffers:
 * RGBA, four channels per texture, ceil(n/4) textures back to back. This is
 * the layout core/region_field.js is contracted to emit.
 */
const chanAt = (i, px) => (Math.floor(i / 4) * WS * WS + px) * 4 + (i % 4);

/**
 * How different two frames are.
 *
 * `sum` -- the total absolute deviation -- is the headline number: unlike the
 * count of differing bytes it does not saturate once every edge has moved, and
 * unlike the maximum it is not set by whatever single pixel happens to sit on
 * the hardest edge. `mean` is that sum over the whole frame, so two runs of
 * different sizes stay comparable.
 */
/**
 * The pixel the injected LSB goes into: the strongest one in the first region,
 * stopping short of 255 so that +1 stays a change of exactly 1. A byte already
 * at 255 would wrap to 0 in the Uint8Array and quietly become a 255-LSB test.
 */
function pickInjectPixel(wd) {
  let best = -1, bestV = -1;
  for (let px = 0; px < WS * WS; px++) {
    const v = wd[px * 4];            // old layout: component 0 is the head
    if (v > bestV && v < 255) { bestV = v; best = px; }
  }
  return best;
}

function diffBytes(a, b) {
  const n = Math.min(a.length, b.length);
  let diff = 0, maxDiff = 0, sum = 0, firstAt = -1;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d) { diff++; sum += d; if (firstAt < 0) firstAt = i; if (d > maxDiff) maxDiff = d; }
  }
  return { diff, maxDiff, sum, mean: sum / n, firstAt, n, sameLength: a.length === b.length };
}

(async () => {
  const pages = [
    ["baseline", path.join(OUT, "demo.baseline.html")],
    ["new     ", path.join(OUT, "demo.html")],
  ];
  for (const [, file] of pages) {
    if (!fs.existsSync(file)) {
      console.error(`missing ${file}`);
      console.error("demo.baseline.html is the frozen pre-refactor build -- do not rebuild it.");
      process.exit(2);
    }
  }

  const profile = path.join(os.tmpdir(), "justdrag-equiv-" + Date.now());
  fs.rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    "--headless=new", "--enable-unsafe-swiftshader", "--hide-scrollbars",
    "--allow-file-access-from-files", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--window-size=1200,800", "about:blank",
  ], { stdio: "ignore" });

  let list = [];
  for (let i = 0; i < 100 && !list.length; i++) {
    try {
      list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`)).filter(t => t.type === "page");
    } catch (_) { /* not up yet */ }
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
    const r = await send("Runtime.evaluate",
      { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");

  const shots = {};
  for (const [label, file] of pages) {
    await send("Page.navigate", { url: pathToFileURL(file).href });
    await sleep(3000);
    const shape = await evalJS(pinScript());
    if (label.trim() === "baseline" && PERTURB) {
      console.log(`  (negative control: baseline head radius -> ${await evalJS(PERTURB_SCRIPT)})`);
    }
    if (shape === "new" && INJECT) {
      // The pixel to poke is the one where the single-ellipse region is
      // strongest -- the same pixel the bit-identical check leans on hardest.
      const px = pickInjectPixel(shots.baseline.wd);
      const v = await evalJS(injectScript(px));
      console.log(`  (negative control: injected +1 LSB into byte ${px * 4} -> ${v}/255)`);
    }
    const r = await evalJS(probeScript());
    const px = Buffer.from(r.px, "base64"), wd = Buffer.from(r.wd, "base64");
    shots[label.trim()] = { shape, px, wd };
    // Only the new build is asked for the yardstick: it is the one whose frame
    // is being judged, and `square()` is not something the old build is
    // promised to still have.
    if (shape === "new") {
      shots[label.trim()].yard = Buffer.from(await evalJS(YARDSTICK_SCRIPT), "base64");
    }
    console.log(`${label}  params=${shape}  canvas ${px.length / 4}px  weights ${wd.length}B`);
  }

  const a = shots.baseline, b = shots.new;
  const yard = diffBytes(a.px, b.yard);
  let fails = 0;
  const verdict = (ok, msg) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) fails++; };

  console.log("\n--- weight channels ---");
  const newLayout = b.shape === "new";
  if (!newLayout) {
    // Pre-refactor on both sides: the only thing to say is that the two builds
    // agree, which is what compare_golden.js already establishes. The invariant
    // below cannot be evaluated until one side is in the new layout.
    const w = diffBytes(a.wd, b.wd);
    verdict(w.diff === 0 && w.sameLength,
      `both builds still per-region: weight maps ${w.n}B, ${w.diff} differing, max |diff| ${w.maxDiff}`);
    console.log("  NOTE  the per-region invariant is only exercised once demo.html is rebuilt"
      + " in the new layout; run this again after Phase 2");
  } else {
    const expected = Math.ceil(TOTAL / 4) * WS * WS * 4;
    verdict(b.wd.length === expected,
      `new weight map is ${b.wd.length}B, expected ${expected}B for ${TOTAL} ellipses`);

    let base = 0;
    const spans = CONFIG.regions.map(r => { const s = [base, base + r.n]; base += r.n; return s; });

    for (let ri = 0; ri < spans.length; ri++) {
      const [lo, hi] = spans[ri];
      let worstShort = 0, worstOver = 0, shortPx = 0, overPx = 0, exact = true;

      for (let px = 0; px < WS * WS; px++) {
        const old = a.wd[px * 4 + ri];        // old layout: component 0 = head, 1 = legs
        let sum = 0;
        for (let i = lo; i < hi; i++) sum += b.wd[chanAt(i, px)];
        const d = old - sum;                  // positive = the new build fell short
        if (d > 0) { shortPx++; if (d > worstShort) worstShort = d; }
        else if (d < 0) { overPx++; if (-d > worstOver) worstOver = -d; }
        if (old !== b.wd[chanAt(lo, px)]) exact = false;
      }

      const budget = BUDGET[ri];
      verdict(worstShort <= budget && worstOver <= budget,
        `region ${ri} (${CONFIG.regions[ri].n} ellipses): short ${worstShort}, over ${worstOver},`
        + ` budget ${budget}  [${shortPx} px short, ${overPx} px over]`);

      if (budget === 0) {
        verdict(exact, `region ${ri}: one ellipse, so M/S == 1 exactly and the channel must be BIT-identical`);
      }
    }
  }

  console.log("\n--- rendered frame ---");
  const f = diffBytes(a.px, b.px);
  const budget = Math.max(...BUDGET);
  console.log(`  refactor  ${f.diff} bytes differ (${(f.diff / f.n * 100).toFixed(4)}%),`
    + ` total |diff| ${f.sum}, worst ${f.maxDiff}/255`);
  console.log(`  yardstick ${yard.diff} bytes differ (${(yard.diff / yard.n * 100).toFixed(4)}%),`
    + ` total |diff| ${yard.sum}, worst ${yard.maxDiff}/255`);
  console.log(`  (a weight deficit of ${budget}/255 of full influence is a fraction of a pixel;`
    + ` a half-pixel shift is the deliberate version of the same error)`);

  // A weight deficit is a sub-pixel error in where the pixel samples from, and
  // what that costs is the picture's own contrast -- so the bar is what the same
  // picture charges for a half-pixel misalignment. A renderer that reads a
  // correct field with the wrong channel mapping misses by far more than that.
  verdict(f.sum < yard.sum,
    `the refactor's total deviation (${f.sum}) is smaller than a deliberate`
    + ` half-pixel shift's (${yard.sum}) on this same picture`);

  ws.close(); chrome.kill();
  await new Promise(r => setTimeout(r, 300));
  fs.rmSync(profile, { recursive: true, force: true });

  const note = PERTURB ? "  (--perturb is the negative control; failing here is the point)" : "";
  console.log(fails ? `\nFAIL  ${fails} check(s) did not hold${note}\n`
                    : `\nPASS  the new build draws what the shipped demo drew\n`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("harness error:", e); process.exit(2); });
