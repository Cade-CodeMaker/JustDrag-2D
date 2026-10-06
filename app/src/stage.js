/**
 * The editing stage: deform preview, region guides, and the pointer editing
 * that drives them.
 *
 * Ported from the GL half of tools/template.html so the editor and the built
 * demo show the same picture. Everything that decides how a pixel moves lives
 * in core/ -- this file only uploads textures, sets uniforms and hit-tests.
 *
 * The unit of motion is the **ellipse**: one weight channel each, so two
 * ellipses inside one region can swing out of step. That is what the per-blob
 * uniforms below are for, and it is why the shader is compiled per texture
 * count rather than once.
 */
import { DeformCore, INNER, DEFORM_SRC } from './core-assets.js';
import { poseAngles, frameRect, fitZoom } from './pose.js';

const VS = `
attribute vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

/** core/deform.glsl, the same source tools/build_demo.py inlines. */
const FS = DEFORM_SRC;

/** Weight-map resolution. Matches WS in tools/template.html. */
const WS = 256;

const DRAG_MIN = -0.4, DRAG_MAX = 1.4;   // blob centres may leave the frame a little
const R_MIN = 0.02, R_MAX = 0.9;
const PIVOT_HIT = 0.035;                 // in image units
const BLOB_HIT = 1.15;                   // in blob radii

/**
 * vec4 uniform slots one ellipse costs: `uBlobXform` and `uBlobColor`.
 *
 * Both are vec4 arrays rather than vec2/vec3 because GLSL ES 1.00 does not pin
 * down how arrays of smaller types pack into uniform storage, and drivers have
 * disagreed about it. One vec4 per element is the only stride that is the same
 * under every packing rule, and it is why the budget below is exact rather than
 * a guess.
 */
const VEC4_PER_BLOB = 2;

/**
 * Everything else the fragment shader declares, in vec4 slots, plus slack.
 *
 * The spec's guaranteed minimum is `MAX_FRAGMENT_UNIFORM_VECTORS == 16`, and
 * this budget is what actually binds before the texture-unit ceiling does: at
 * 16 vectors a device fits four ellipses, not the 28 texture units would allow.
 * So the limit is queried rather than assumed -- see `capacity()`.
 */
const FIXED_VEC4 = 8;

export const BG_NAMES = ['棋盘', '深色', '浅色'];

/**
 * The capacity arithmetic on its own, so both branches can be checked without a
 * device that happens to be short of uniforms.
 *
 * Two ceilings, and which one bites depends entirely on the hardware: weight
 * textures cost one texture unit per four ellipses and WebGL1 guarantees 8
 * units, so 28; uniforms cost two vec4 per ellipse and the spec only guarantees
 * 16 vectors, so 4. A spec-minimum device is uniform-bound by a factor of seven,
 * which is why this is queried rather than written down anywhere.
 */
export function capacityFrom(units, vecs) {
  const byTexture = Math.max(0, (units - 1) * 4);
  const byUniform = Math.max(0, Math.floor((vecs - FIXED_VEC4) / VEC4_PER_BLOB));
  return { max: Math.min(byTexture, byUniform), byTexture, byUniform, units, vecs };
}

// ---------------------------------------------------------------- painting ---

/**
 * Draw one deformed frame into whatever framebuffer is currently bound.
 *
 * Every input is a parameter, including the phase and the target size. That is
 * deliberate: the live preview and the GIF exporter both call this, and the only
 * way they can be guaranteed to agree on what frame N looks like is for there to
 * be one implementation. Anything either of them read off `this` -- the
 * animation clock, the canvas size -- would be a second source of truth.
 *
 * The viewport is set here rather than in _resize, for the same reason: whoever
 * paints owns the viewport, so painting into an offscreen target of a different
 * size needs no restore logic.
 *
 * `pose` is the caller's preallocated `{ xform, color }` pair, already filled
 * for this phase. It is passed in rather than built here because this runs once
 * per frame, and once per frame is not a rate at which to allocate two
 * `Float32Array`s.
 */
export function paintPose(gl, u, { params, pose, w, h, weights = false, bg = 2 }) {
  gl.viewport(0, 0, w, h);
  gl.uniform2f(u.res, w, h);
  gl.uniform1f(u.zoom, params.zoom);
  gl.uniform1i(u.mode, weights ? 1 : 0);
  gl.uniform1i(u.bg, bg);
  gl.uniform4fv(u.xform, pose.xform);
  gl.uniform4fv(u.color, pose.color);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

/**
 * readPixels returns rows bottom-up -- GL's origin is bottom-left -- and every
 * image format we hand pixels to wants them top-down. Row `h-1-y` becomes row
 * `y`.
 *
 * (The two existing readPixels in this repo, in verify/compare_equivalence.js and
 * ui.test.js, skip this. They get away with it because both sides of their
 * comparison are bottom-up, so the flip cancels. An export has nothing to
 * cancel against.)
 */
function flipRows(src, dst, w, h) {
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    dst.set(src.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  }
}

/**
 * Flip, and fill the pixels the shader never drew with `bg`.
 *
 * At zoom < 1 the framing square is smaller than the frame (deform.glsl:29
 * early-returns outside it), so the capture has a transparent ring -- and an
 * opaque GIF renders that ring black. Alpha is the shader's own verdict on
 * where it drew: 1.0 in-square, never written outside. Testing it is exact,
 * where re-deriving the square's bounds here would risk an off-by-one that
 * paints a one-pixel black edge -- the kind of thing that ships.
 */
function flipAndFill(src, dst, w, h, bg) {
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    const s = (h - 1 - y) * row, d = y * row;
    for (let x = 0; x < w; x++) {
      const sp = s + (x << 2), dp = d + (x << 2);
      if (src[sp + 3] === 0) { dst[dp] = bg[0]; dst[dp + 1] = bg[1]; dst[dp + 2] = bg[2]; }
      else { dst[dp] = src[sp]; dst[dp + 1] = src[sp + 1]; dst[dp + 2] = src[sp + 2]; }
      dst[dp + 3] = 255;
    }
  }
}

/**
 * The flat backdrop colour, read back from the rendered frame rather than
 * hardcoded from deform.glsl.
 *
 * Those constants go through float32 and a rounding convert, and it shows:
 * 0.90*255 is 229.4999... in float32, so the light background lands on 229, not
 * the 230 the decimal suggests. A fill one off from the backdrop would draw a
 * faint seam along the square's edge -- and a flat field is precisely where a
 * 1/255 step is visible.
 *
 * Sampled from a band just inside the square's perimeter, where a letterboxed
 * cutout is background by construction. Taking the mode of a sparse sample
 * instead would be fooled by a character with a large flat area of its own.
 */
export function bgColorOf(src, w, h, rect) {
  const [x0, y0, x1, y1] = rect;
  const X0 = Math.max(0, Math.ceil(x0)), X1 = Math.min(w, Math.floor(x1));
  const Y0 = Math.max(0, Math.ceil(y0)), Y1 = Math.min(h, Math.floor(y1));
  const side = Math.min(X1 - X0, Y1 - Y0);
  const band = Math.max(1, Math.round(side * 0.04));
  const step = Math.max(1, Math.round(side / 96));

  const counts = new Map();
  const note = (x, y) => {
    const p = (y * w + x) << 2;
    if (src[p + 3] === 0) return;
    const k = (src[p] << 16) | (src[p + 1] << 8) | src[p + 2];
    counts.set(k, (counts.get(k) || 0) + 1);
  };

  for (let x = X0; x < X1; x += step) {
    for (let d = 0; d < band; d++) { note(x, Y0 + d); note(x, Y1 - 1 - d); }
  }
  for (let y = Y0; y < Y1; y += step) {
    for (let d = 0; d < band; d++) { note(X0 + d, y); note(X1 - 1 - d, y); }
  }

  let best = 0, bestN = -1;
  for (const [k, n] of counts) if (n > bestN) { bestN = n; best = k; }
  // Nothing sampled means the character covers the square's edge to edge, so
  // there is no backdrop to match; 0.90 -> 229 is the light background.
  if (bestN < 0) return [229, 229, 229];
  return [(best >> 16) & 255, (best >> 8) & 255, best & 255];
}

// ---------------------------------------------------------------- overlay ---

/**
 * A pill label, so a pivot can say which body part it belongs to.
 *
 * Drawn on the overlay canvas rather than as a DOM node: the overlay is already
 * repainted every rAF frame and already knows where the pivot lands in screen
 * space, so this needs no positioning logic of its own and cannot desync from
 * the crosshair it labels.
 */
function pill(ov, text, x, y, rgb) {
  ov.font = '600 13px ui-sans-serif, system-ui, "Segoe UI", sans-serif';
  ov.textBaseline = 'middle';
  const tw = ov.measureText(text).width;
  const w = Math.round(tw) + 16, h = 22;
  // To the right of the pivot, flipping left if that would leave the canvas.
  let bx = x + 16;
  if (bx + w > ov.canvas.clientWidth - 4) bx = x - 16 - w;
  const by = y - h / 2;

  ov.beginPath();
  if (ov.roundRect) ov.roundRect(bx, by, w, h, 6);
  else ov.rect(bx, by, w, h);
  ov.fillStyle = 'rgba(12,14,18,0.88)';
  ov.fill();
  ov.strokeStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  ov.lineWidth = 1.5;
  ov.stroke();

  ov.fillStyle = '#fff';
  ov.fillText(text, bx + 8, by + h / 2 + 0.5);
}

export class Stage {
  /**
   * @param glc  canvas for the deform pass
   * @param ovc  canvas for guides / still image
   * @param hooks { onEdit, onSelect, onDiag }
   */
  constructor(glc, ovc, hooks = {}) {
    this.glc = glc;
    this.ovc = ovc;
    this.hooks = hooks;
    this.ov = ovc.getContext('2d');

    const gl = glc.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: true })
            || glc.getContext('experimental-webgl', { alpha: true, premultipliedAlpha: false });
    if (!gl) throw new Error('浏览器未提供 WebGL 上下文，无法预览形变。');
    this.gl = gl;

    /**
     * 'image' shows a still (steps 1-2, before anything is deformable);
     * 'deform' runs the shader (step 3 onward).
     */
    this.mode = 'image';
    this.image = null;

    /** Mirrors of the app's state. main.js mutates these in place. */
    this.regions = null;
    this.params = null;
    this.view = { weights: false, guides: true, bg: 0, playing: true };
    /**
     * Whether this step wants guides at all, independent of the user's toggle.
     * The export step previews the finished thing, and the guides are editor
     * furniture that the deliverable does not have -- showing them there would
     * misrepresent what is about to be written out.
     */
    this.showGuides = false;

    /**
     * Live reference into `regions`: `{reg, blob, kind}`, where `kind` is
     * "blob" or "pivot" and `blob` is null for a pivot.
     *
     * By object identity rather than by index or name: a region can be renamed
     * to anything (including to another region's name) and ellipses get added
     * and removed while a selection is live, so an index or a key would go
     * stale the moment the list changed.
     */
    this.sel = null;
    /** `{reg, blob, kind}` under the cursor, for the pivot label and the cursor shape. */
    this.hover = null;

    this._drag = null;
    this._t0 = performance.now();
    this._phase = 0;
    this._raf = 0;

    /** Per-texture-count program cache: k -> {prog, u, aPos}. At most 7 entries. */
    this._progs = new Map();
    this._cur = null;
    /** Ellipses this device can actually deform; see capacity(). */
    this._maxBlobs = Infinity;
    /** Set when the project outgrows the device, so the panel can say why it froze. */
    this.diag = '';

    // A reduced-motion preference should stop the idle animation, not the tool.
    this._reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    this._initGL();
    this._initInput();
  }

  // ----------------------------------------------------------------- gl ---

  /**
   * How many ellipses this device's fragment uniform budget can hold.
   *
   * Queried, never assumed. The texture side allows 7 weight textures plus the
   * character (WebGL1 guarantees 8 texture units), which is 28 ellipses -- but
   * `MAX_FRAGMENT_UNIFORM_VECTORS` is only guaranteed to be 16, and at two vec4
   * per ellipse that is four. The smaller of the two is what is real, and on
   * spec-minimum hardware the uniform budget wins by a wide margin.
   */
  capacity() {
    const gl = this.gl;
    return capacityFrom(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
                        gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS));
  }

  _initGL() {
    const gl = this.gl;

    this.gpuInfo = '';
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const v = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      const r = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      this.gpuInfo = `GL: ${v} / ${r}\nWebGL ${gl.getParameter(gl.VERSION)} · GLSL ${gl.getParameter(gl.SHADING_LANGUAGE_VERSION)}`;
    } catch (_) { /* renderer info is best-effort */ }

    this._maxBlobs = this.capacity().max;

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this._quad = quad;

    this.texChar = this._makeTexture(gl.LINEAR);
    this.texW = [];

    this._resize();
    new ResizeObserver(() => { this._resize(); this.draw(); }).observe(this.glc);
  }

  _makeTexture(filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    return t;
  }

  /**
   * The program specialised for `n` ellipses, compiled on first use.
   *
   * Keyed on the ellipse count, not on the weight-texture count that the
   * `#define` is named after. Those differ: 1..4 ellipses all make one weight
   * texture, but the uniform arrays are declared `[N_BLOB]` and sized to the
   * real count, so the 4-ellipse program cannot serve a 3-ellipse project --
   * its arrays are a vec4 longer than the `Float32Array` that would be uploaded
   * to them. Reusing it silently uploads short, or overruns; either way the
   * answer is to compile per count and let the count be the key.
   */
  _program(n) {
    const hit = this._progs.get(n);
    if (hit) return hit;
    const gl = this.gl;
    const k = DeformCore.textureCount(n);
    // Adding and removing ellipses walks through counts one at a time; without
    // a cap, a long editing session would keep every one of them alive.
    if (this._progs.size >= 16) {
      for (const p of this._progs.values()) gl.deleteProgram(p.prog);
      this._progs.clear();
    }

    const compile = (type, src, label) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s) || '(no log)';
        // Pull the offending source lines out of the log so the message is
        // actionable instead of "the shader failed".
        const lines = src.split('\n');
        const hits = [...log.matchAll(/(?:ERROR:\s*\d+:(\d+)|^\s*(\d+):(\d+))/gm)]
          .map(m => parseInt(m[1] || m[3], 10)).filter(n => !isNaN(n));
        const ctx = hits.length
          ? '\n  ' + hits.slice(0, 3).map(n => `${n}| ${(lines[n - 2] || '').trim()}`).join('\n  ')
          : '';
        throw new Error(`${label}着色器编译失败：\n${log}${ctx}`);
      }
      return s;
    };

    // The defines go in front of the source rather than into a baked variant,
    // so core/deform.glsl stays one file on disk that both this and
    // tools/build_demo.py inline verbatim.
    const src = DeformCore.shaderDefines(n) + FS;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS, '顶点'));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, src, '片元'));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('着色器链接失败：' + (gl.getProgramInfoLog(prog) || '(no log)'));
    }

    gl.useProgram(prog);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const U = n => gl.getUniformLocation(prog, n);
    const u = {
      tex: U('uTex'), res: U('uRes'), zoom: U('uZoom'),
      mode: U('uMode'), bg: U('uBg'),
      xform: U('uBlobXform'), color: U('uBlobColor'),
      weight: [],
    };
    // Every declared sampler has to be pointed at its own unit explicitly.
    // A sampler uniform defaults to 0, so one that is missed silently samples
    // the *character* texture -- which looks like a plausible picture, just the
    // wrong one. That is the whole reason this loop is not optimised away.
    gl.uniform1i(u.tex, 0);
    for (let i = 0; i < k; i++) {
      const loc = U(`uWeight${i}`);
      if (loc) gl.uniform1i(loc, 1 + i);
      u.weight.push(loc);
    }

    const entry = { prog, u, aPos };
    this._progs.set(n, entry);
    return entry;
  }

  /** Make `k` weight textures exist and be bound to units 1..k. */
  _ensureWeightTextures(k) {
    const gl = this.gl;
    while (this.texW.length < k) {
      const t = this._makeTexture(gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, WS, WS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.texW.push(t);
    }
  }

  /**
   * Put the character on unit 0 and the weight textures on 1..k.
   *
   * The one place that decides which texture lives on which unit. Anything that
   * calls `activeTexture` has to end by restoring this, or the next draw reads
   * whatever was left bound -- which is the failure mode where the deformation
   * quietly samples the character image as a weight field.
   */
  _bindAllTextures() {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texChar);
    for (let i = 0; i < this.texW.length; i++) {
      gl.activeTexture(gl.TEXTURE0 + 1 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.texW[i]);
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Upload the cut-out character. Accepts anything drawable by texImage2D. */
  setCharacter(source) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texChar);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  // ------------------------------------------------------------- weights ---

  /**
   * Recompute the channel order, the uniform arrays and the weight textures for
   * the current region list.
   *
   * Called on any change that can move an ellipse between channels: adding or
   * removing one, or removing a whole region. Everything else -- dragging,
   * resizing, retuning -- goes through `buildWeights(reg)` instead.
   */
  _relayout() {
    const gl = this.gl;
    const regions = this.regions || [];
    const { blobs, regs } = DeformCore.flatBlobs(regions);

    // Channel ranges, in flatBlobs order -- one pass so the layout is stated once.
    const lo = [];
    let c = 0;
    for (const reg of regions) { lo.push(c); c += reg.blobs.length; }

    const n = c;
    const k = DeformCore.textureCount(n);
    this._layout = { blobs, regs, lo, n, k };

    // Uniform arrays sized to the real count, with room for the padded loop.
    this.pose = {
      xform: new Float32Array(Math.max(1, n) * 4),
      color: new Float32Array(Math.max(1, n) * 4),
    };

    this._ensureWeightTextures(k);
    this._cur = this._program(n);

    this._weights = new Uint8Array(k * WS * WS * 4);
    this._bindAllTextures();

    const cap = this.capacity();
    if (n > cap.max) {
      this.diag = `这个项目有 ${n} 个椭圆，但这台设备的显卡最多只能同时驱动 ${cap.max} 个`
        + `（着色器 uniform 上限 ${cap.vecs} 个 vec4 / 纹理单元 ${cap.units} 个）。`
        + `请减少椭圆数量 —— 现在画面里的形变已停止更新。`;
    } else {
      this.diag = '';
    }
    this.hooks.onDiag?.(this.diag);
    return this._layout;
  }

  setRegions(regions) {
    // Nothing replaces `regions` wholesale while a selection exists -- the
    // overlay matches blobs by object identity -- so a swap has to drop `sel`.
    this.regions = regions;
    this.sel = null;
    this.hover = null;
    this._relayout();
    this.buildWeights();
    this.draw();
  }

  /** Re-run the layout after an add/remove, keeping the selection if it survives. */
  rebuild() {
    this._relayout();
    this.buildWeights();
    this.afterEdit();
  }

  /**
   * Rasterise the weight field and upload it.
   *
   * With `reg`, only that region's channels are recomputed -- the bake is
   * per-region, so nothing else can have changed -- and only the textures those
   * channels live in are re-uploaded.
   *
   * That is not a micro-optimisation. This hangs off `afterEdit`, which runs on
   * every `pointermove` of a drag: recomputing all 65536 pixels for all n
   * ellipses is 1.8M ellipse evaluations at 28 ellipses, tens of milliseconds
   * per frame, and it is the one place the editor actually stutters. Dragging
   * one ellipse only ever needs its own region.
   */
  buildWeights(reg) {
    if (!this._layout) return;

    let t0 = 0, t1 = this._layout.k - 1;
    if (reg) {
      const r = this._layout.lo[this.regions.indexOf(reg)];
      if (r === undefined) { this.buildWeights(); return; }   // not in the list any more
      const n = reg.blobs.length;
      if (!n) return;
      this._rasterizeRegion(reg, r);
      t0 = Math.floor(r / 4);
      t1 = Math.floor((r + n - 1) / 4);
    } else {
      let c = 0;
      for (const rg of this.regions) {
        if (rg.blobs.length) this._rasterizeRegion(rg, c);
        c += rg.blobs.length;
      }
    }
    this._uploadWeights(t0, t1);
  }

  /**
   * One region's channels, into `this._weights` at channel offset `lo`.
   *
   * The bake: `k = M / S` scales the region's per-ellipse weights so they sum
   * back to the region's coverage `M` -- exactly the value the region held as a
   * single channel before ellipses got channels of their own. With one ellipse
   * `M/S` is `w/w`, which is exactly 1.0 in IEEE, so that case is bit-identical
   * to never having scaled at all.
   *
   * `S == 0` is guarded to `k = 0` rather than left to divide: 0/0 is NaN, and
   * writing NaN into a Uint8Array stores 0 silently, so the guard is the only
   * thing standing between an empty pixel and a channel that looks deliberate.
   */
  _rasterizeRegion(reg, lo) {
    const size = WS, data = this._weights;
    const blobs = reg.blobs, n = blobs.length;
    const ws = this._ws || (this._ws = []);
    const BW = DeformCore.blobWeight;

    for (let j = 0; j < size; j++) {
      const y = (j + 0.5) / size;
      for (let i = 0; i < size; i++) {
        const x = (i + 0.5) / size;
        const pixel = j * size + i;

        let M = 0, S = 0;
        for (let b = 0; b < n; b++) {
          const w = BW(x, y, blobs[b]);
          ws[b] = w;
          S += w;
          if (w > M) M = w;
        }
        const k = S > 0 ? M / S : 0;
        for (let b = 0; b < n; b++) {
          const c = lo + b;
          data[(Math.floor(c / 4) * size * size + pixel) * 4 + (c % 4)] = 255 * ws[b] * k;
        }
      }
    }
  }

  /** Push the given texture range back to the GPU. */
  _uploadWeights(t0, t1) {
    const gl = this.gl;
    const px = WS * WS;
    gl.activeTexture(gl.TEXTURE1);
    for (let t = t0; t <= t1; t++) {
      gl.bindTexture(gl.TEXTURE_2D, this.texW[t]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WS, WS, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(this._weights.buffer, t * px * 4, px * 4));
    }
    this._bindAllTextures();
  }

  /**
   * Fill `this.pose` for one instant.
   *
   * The rotation is precomputed here as `(cos, sin)` rather than handed to the
   * shader as an angle. It trades a rounding difference of about 1 ulp against
   * removing sin/cos from every fragment -- which, at 512x512 and 60fps, is
   * several million transcendental evaluations a second for no reason.
   */
  poseAt(phase) {
    const L = this._layout, pose = this.pose;
    if (!L) return pose;
    const harm = this.params ? this.params.harm : 0;
    const degs = poseAngles(L.blobs, harm, phase);
    const xf = pose.xform, col = pose.color;
    for (let i = 0; i < L.n; i++) {
      const reg = L.regs[i];
      const th = degs[i] * Math.PI / 180;
      xf[i * 4] = reg.pivot[0];
      xf[i * 4 + 1] = reg.pivot[1];
      xf[i * 4 + 2] = Math.cos(th);
      xf[i * 4 + 3] = Math.sin(th);
      col[i * 4] = reg.color[0] / 255;
      col[i * 4 + 1] = reg.color[1] / 255;
      col[i * 4 + 2] = reg.color[2] / 255;
      col[i * 4 + 3] = 0;
    }
    return pose;
  }

  _resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.glc.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.glc.clientHeight * dpr));
    for (const c of [this.glc, this.ovc]) {
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
    this.ov.setTransform(dpr, 0, 0, dpr, 0, 0);
    gl.viewport(0, 0, w, h);
  }

  // -------------------------------------------------------- coordinates ---

  /** The centered square the image is mapped into. Shared by shader, overlay and input. */
  square() {
    const w = this.glc.clientWidth, h = this.glc.clientHeight;
    const side = Math.min(w, h) * (this.params ? this.params.zoom : 1);
    return { side, ox: (w - side) / 2, oy: (h - side) / 2 };
  }
  toScreen(x, y) {
    const q = this.square();
    return [q.ox + x * q.side, q.oy + y * q.side];
  }
  toImage(clientX, clientY) {
    const r = this.glc.getBoundingClientRect(), q = this.square();
    return [(clientX - r.left - q.ox) / q.side, (clientY - r.top - q.oy) / q.side];
  }

  // ------------------------------------------------------------ overlay ---

  drawOverlay() {
    const ov = this.ov;
    const w = this.glc.clientWidth, h = this.glc.clientHeight;
    ov.clearRect(0, 0, w, h);

    if (this.mode === 'image') {
      if (this.image) {
        const q = this.square();
        // Stretched into the square exactly like the shader samples it, so what
        // the editor frames is what the demo will frame.
        ov.imageSmoothingEnabled = true;
        ov.imageSmoothingQuality = 'high';
        ov.drawImage(this.image, q.ox, q.oy, q.side, q.side);
      }
      return;
    }

    if (!this.showGuides || !this.view.guides || !this.regions) return;

    const q = this.square();
    const sel = this.sel;

    for (const reg of this.regions) {
      const col = reg.color;
      for (const b of reg.blobs) {
        const [cx, cy] = this.toScreen(b.c[0], b.c[1]);
        const rx = b.r[0] * q.side, ry = b.r[1] * q.side;
        const th = b.rot * Math.PI / 180;
        const isSel = !!sel && sel.blob === b;

        ov.lineWidth = 2;
        ov.beginPath();
        ov.ellipse(cx, cy, rx, ry, th, 0, Math.PI * 2);
        ov.strokeStyle = isSel ? '#ffffff' : `rgba(${col[0]},${col[1]},${col[2]},0.85)`;
        ov.stroke();
        if (isSel) { ov.fillStyle = 'rgba(255,255,255,0.10)'; ov.fill(); }

        // Inner boundary: inside it the pixel follows this ellipse fully.
        ov.beginPath();
        ov.ellipse(cx, cy, rx * INNER, ry * INNER, th, 0, Math.PI * 2);
        ov.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},0.30)`;
        ov.lineWidth = 1; ov.stroke(); ov.lineWidth = 2;

        // Which way this ellipse is pointing.
        //
        // Rotating the ellipse is only legible if there is something in it that
        // is not symmetric, and a bare ellipse has nothing -- a quarter turn
        // looks like the same ellipse. So: a line out along the local -y axis,
        // which is screen-up at rot = 0 and swings with the rotation. (Not +y:
        // y runs down here, so local +y would hang below the centre and the
        // reference tick would read as a tail rather than as a heading.)
        // Drawn for every ellipse, since the point is to compare them; the
        // selected one gets a brighter, longer line and a cap.
        const L = ry * (isSel ? 1.35 : 1.12);
        const ux = Math.sin(th), uy = -Math.cos(th);
        ov.beginPath();
        ov.moveTo(cx, cy);
        ov.lineTo(cx + ux * L, cy + uy * L);
        ov.strokeStyle = isSel ? 'rgba(255,255,255,0.95)' : `rgba(${col[0]},${col[1]},${col[2]},0.55)`;
        ov.lineWidth = isSel ? 2.5 : 1.5;
        ov.stroke();
        if (isSel) {
          ov.beginPath();
          ov.arc(cx + ux * L, cy + uy * L, 3.5, 0, Math.PI * 2);
          ov.fillStyle = '#fff'; ov.fill();
        }

        ov.beginPath();
        ov.arc(cx, cy, 4, 0, Math.PI * 2);
        ov.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`; ov.fill();

        if (isSel) ellipseLabel(ov, reg, b, cx, cy + Math.max(ry, 14) + 4, col);
      }

      const [px, py] = this.toScreen(reg.pivot[0], reg.pivot[1]);
      const pivotSel = !!sel && sel.kind === 'pivot' && sel.reg === reg;
      const pivotHot = pivotSel || (this.hover && this.hover.kind === 'pivot' && this.hover.reg === reg);

      ov.strokeStyle = pivotSel ? '#ffd24d' : '#ff4d4d';
      ov.lineWidth = pivotHot ? 3 : 2.5;
      ov.beginPath();
      ov.moveTo(px - 12, py); ov.lineTo(px + 12, py);
      ov.moveTo(px, py - 12); ov.lineTo(px, py + 12); ov.stroke();
      ov.beginPath(); ov.arc(px, py, 6, 0, Math.PI * 2);
      ov.strokeStyle = '#fff'; ov.lineWidth = 2; ov.stroke();

      // The label is the only thing that says which body part this pivot turns.
      // A crosshair is a crosshair; without text there is no way to tell the
      // head's from the chest's once there are three of them.
      if (pivotHot) pill(ov, reg.name, px, py, col);
    }
    ov.lineWidth = 2;
  }

  // -------------------------------------------------------------- input ---

  _initInput() {
    const glc = this.glc;
    this.ovc.style.pointerEvents = 'none';
    glc.style.cursor = 'default';

    glc.addEventListener('pointerdown', e => {
      if (this.mode !== 'deform') return;
      const [ix, iy] = this.toImage(e.clientX, e.clientY);
      const h = this._hit(ix, iy);
      if (!h) { this.sel = null; this.drawOverlay(); this.hooks.onSelect?.(); return; }
      this.sel = h;
      const target = h.kind === 'pivot' ? h.reg.pivot : h.blob.c;
      this._drag = { dx: ix - target[0], dy: iy - target[1] };
      glc.setPointerCapture(e.pointerId);
      glc.style.cursor = 'grabbing';
      this.drawOverlay();
      this.hooks.onSelect?.();
    });

    glc.addEventListener('pointermove', e => {
      if (this.mode !== 'deform') return;
      const [ix, iy] = this.toImage(e.clientX, e.clientY);
      if (!this._drag) {
        const h = this._hit(ix, iy);
        const same = h && this.hover && h.kind === this.hover.kind
          && h.reg === this.hover.reg && h.blob === this.hover.blob;
        if (!same) {
          this.hover = h;
          // The overlay is repainted every rAF frame, so the label follows the
          // cursor with no extra invalidation logic -- only the cursor shape
          // has to be set here.
          glc.style.cursor = h ? 'grab' : 'default';
        }
        return;
      }
      if (this.sel.kind === 'pivot') {
        const p = this.sel.reg.pivot;
        p[0] = Math.min(DRAG_MAX, Math.max(DRAG_MIN, ix - this._drag.dx));
        p[1] = Math.min(DRAG_MAX, Math.max(DRAG_MIN, iy - this._drag.dy));
        this.touch();
      } else {
        const c = this.sel.blob.c;
        c[0] = Math.min(DRAG_MAX, Math.max(DRAG_MIN, ix - this._drag.dx));
        c[1] = Math.min(DRAG_MAX, Math.max(DRAG_MIN, iy - this._drag.dy));
        this.afterEdit(this.sel.reg);
      }
    });

    const end = () => {
      if (this._drag) this.hooks.onEdit?.({ committed: true });
      this._drag = null;
      glc.style.cursor = 'default';
    };
    glc.addEventListener('pointerup', end);
    glc.addEventListener('pointercancel', end);
    glc.addEventListener('pointerleave', () => {
      if (this.hover) { this.hover = null; glc.style.cursor = 'default'; }
    });

    glc.addEventListener('wheel', e => {
      if (this.mode !== 'deform') return;
      const [ix, iy] = this.toImage(e.clientX, e.clientY);
      const h = this._hit(ix, iy);
      if (!h || h.kind !== 'blob') return;
      e.preventDefault();
      const b = h.blob;
      if (e.shiftKey) {
        b.rot = normDeg(b.rot + (e.deltaY > 0 ? 3 : -3));
      } else {
        const f = e.deltaY > 0 ? 1.04 : 1 / 1.04;
        b.r[0] = Math.min(R_MAX, Math.max(R_MIN, b.r[0] * f));
        b.r[1] = Math.min(R_MAX, Math.max(R_MIN, b.r[1] * f));
      }
      this.sel = h;
      this.afterEdit(h.reg);
    }, { passive: false });
  }

  _hit(ix, iy) {
    if (!this.regions) return null;
    // Later regions paint over earlier ones, so test in reverse -- same for
    // blobs inside a region, where clicking an overlap should select the one
    // visibly on top.
    for (let r = this.regions.length - 1; r >= 0; r--) {
      const reg = this.regions[r];
      for (let i = reg.blobs.length - 1; i >= 0; i--) {
        const b = reg.blobs[i];
        // Into the blob's own axes first: the ellipse is drawn rotated, so an
        // axis-aligned test would miss the ends and catch the corners.
        const th = b.rot * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
        const dx = ix - b.c[0], dy = iy - b.c[1];
        const qx = dx * c + dy * s, qy = -dx * s + dy * c;
        if (Math.hypot(qx / b.r[0], qy / b.r[1]) < BLOB_HIT) return { reg, blob: b, kind: 'blob' };
      }
      if (Math.hypot(ix - reg.pivot[0], iy - reg.pivot[1]) < PIVOT_HIT) {
        return { reg, blob: null, kind: 'pivot' };
      }
    }
    return null;
  }

  /** Every mutation of `regions` funnels through here, with the region it touched. */
  afterEdit(reg) {
    this.buildWeights(reg);
    this.drawOverlay();
    this.hooks.onEdit?.({});
  }

  /**
   * A change that moves no ellipse at all: the pivot, the colour, the name.
   *
   * All three are read per frame -- the pivot from `poseAt`, the colour from
   * `uBlobColor` -- so the next frame picks them up with nothing rebuilt. A
   * pivot drag runs this on every `pointermove`, and re-baking a region's weight
   * field there would be 65536 ellipse evaluations per frame to produce bytes
   * that are already correct.
   */
  touch() {
    this.drawOverlay();
    this.hooks.onEdit?.({});
  }

  // -------------------------------------------------------------- frame ---

  start() {
    if (this._raf) return;
    this._t0 = performance.now();
    const loop = now => { this.draw(now); this._raf = requestAnimationFrame(loop); };
    this._raf = requestAnimationFrame(loop);
  }
  stop() { cancelAnimationFrame(this._raf); this._raf = 0; }

  /** Paint one frame now. Split from the loop so a tab can be painted before rAF is granted. */
  draw(now = performance.now()) {
    const gl = this.gl;
    const dt = Math.min(0.05, (now - this._t0) / 1000);
    this._t0 = now;
    if (this.view.playing && !this._reduce) this._phase += dt;

    // Cleared unconditionally: in 'image' mode nothing else touches the GL
    // canvas, and the last deformed frame would otherwise stay on screen behind
    // the still -- a ghost of a picture the user is no longer looking at.
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Over the device's ellipse budget the uniforms would silently wrap and the
    // picture would be wrong in a way that looks like a tuning mistake. Freeze
    // instead, and let the panel say so -- see _relayout.
    if (this.mode === 'deform' && this.regions && this.params && this._cur && !this.diag) {
      paintPose(gl, this._cur.u, {
        params: this.params,
        pose: this.poseAt(this._phase),
        w: this.glc.width,
        h: this.glc.height,
        weights: this.view.weights,
        bg: this.view.bg,
      });
    }

    this.drawOverlay();
  }

  // -------------------------------------------------------------- export ---

  /**
   * An offscreen target of exactly w x h, created on first use.
   *
   * A framebuffer rather than a second canvas and GL context: this one shares
   * the compiled program, the uploaded character and the weight field, and it
   * is unaffected by the preview canvas's `antialias: true` -- so a captured
   * frame is the frame, not a resolved multisample approximation of it.
   */
  _renderTarget(w, h) {
    const gl = this.gl;
    if (this._fbo && this._fboW === w && this._fboH === h) return this._fbo;

    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (w > max || h > max) {
      throw new Error(`导出尺寸 ${w}x${h} 超出这台设备的贴图上限 ${max}，请选小一档。`);
    }

    this._disposeTarget();

    // Unit 0 is scratch for the allocation. The target texture is never
    // sampled -- it is a render target -- so it needs a unit only long enough
    // to be created, and unit 0 is the one slot guaranteed to be free of
    // weight textures. (This used to be unit 2, which collided with the weight
    // field as soon as a project had more than four ellipses.)
    gl.activeTexture(gl.TEXTURE0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
                          [gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST]]) {
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    }

    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Unit 0 held the character and now holds a dead render-target texture, so
    // put the whole sampler set back whether or not the attachment worked.
    this._bindAllTextures();

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fb);
      gl.deleteTexture(tex);
      throw new Error(`离屏缓冲创建失败（0x${status.toString(16)}），该尺寸在这台设备上不可用。`);
    }

    this._fbo = fb; this._fboTex = tex; this._fboW = w; this._fboH = h;
    return fb;
  }

  _disposeTarget() {
    const gl = this.gl;
    if (this._fbo) gl.deleteFramebuffer(this._fbo);
    if (this._fboTex) gl.deleteTexture(this._fboTex);
    this._fbo = this._fboTex = null;
    this._fboW = this._fboH = 0;
  }

  /**
   * Render `phases` offscreen, yielding one opaque RGBA frame per phase.
   *
   * A generator, not an array: at 768px, 100 frames is 300MB, and the encoder
   * only ever needs the frame in front of it.
   *
   * `bg` is the shader's backdrop (1 dark, 2 light -- never 0, the checker is
   * editor furniture). The animation clock is not consulted and
   * `prefers-reduced-motion` is not honoured: this is a recording of the
   * animation, and a viewer who has reduced motion set still asked for a GIF.
   *
   * Framing is at `fitZoom(params.zoom)`, not `params.zoom`: the preview may
   * frame at any zoom it likes, but the frame being written here is the whole
   * artwork and must contain all of it. See fitZoom in pose.js.
   */
  async *renderFrames({ width, height, phases, bg = 2 }) {
    const gl = this.gl;
    if (!this.params || !this.regions) throw new Error('还没有可导出的形变内容。');
    if (this.diag) throw new Error(this.diag);

    const zoom = fitZoom(this.params.zoom);
    const params = zoom === this.params.zoom ? this.params : { ...this.params, zoom };
    const rect = frameRect(width, height, zoom);
    const ring = rect[0] > 0;

    const fb = this._renderTarget(width, height);
    const src = new Uint8Array(width * height * 4);
    let fill = null;

    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    try {
      for (const phase of phases) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        paintPose(gl, this._cur.u, {
          params, pose: this.poseAt(phase),
          w: width, h: height, weights: false, bg,
        });
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, src);

        const out = new Uint8Array(src.length);
        // Skipping the per-pixel fill when the square covers the frame keeps the
        // common case a plain set per row.
        if (ring) {
          if (!fill) fill = bgColorOf(src, width, height, rect);
          flipAndFill(src, out, width, height, fill);
        } else {
          flipRows(src, out, width, height);
        }
        yield out;
      }
    } finally {
      // Whoever paints next sets its own viewport, but the bound framebuffer is
      // ours to put back -- an abandoned export must not leave the editor
      // drawing into an offscreen buffer.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._resize();
    }
  }
}

/**
 * A caption under the selected ellipse: which region it belongs to, and where
 * it sits in that region's list.
 *
 * The pivot label says which body part a pivot turns; with several ellipses in
 * one region, this is what says which of them is selected -- otherwise "I
 * picked an ellipse" is all the panel can tell you.
 */
function ellipseLabel(ov, reg, blob, cx, cy, col) {
  const text = `${reg.name} · 椭圆 ${reg.blobs.indexOf(blob) + 1}/${reg.blobs.length}`;
  ov.font = '600 12px ui-sans-serif, system-ui, "Segoe UI", sans-serif';
  ov.textBaseline = 'middle';
  const w = Math.round(ov.measureText(text).width) + 14;
  const x = cx - w / 2, y = cy;
  ov.beginPath();
  if (ov.roundRect) ov.roundRect(x, y, w, 20, 5);
  else ov.rect(x, y, w, 20);
  ov.fillStyle = 'rgba(12,14,18,0.85)';
  ov.fill();
  ov.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
  ov.fillText(text, x + 7, y + 10.5);
}

export const normDeg = d => ((d + 180) % 360 + 360) % 360 - 180;
