/**
 * Build demo.html in the browser -- a port of tools/build_demo.py.
 *
 * The two must agree, because they produce the same artifact from the same
 * inputs: a self-contained file that runs from a double-click, with no server
 * and no CORS trouble, because the texture goes in as a data URI.
 *
 * Everything here that looks fussy is a check build_demo.py also makes. A bad
 * substitution does not fail loudly in a browser -- it produces a page that is
 * blank when opened, which is the worst possible place to find out.
 */
import { TEMPLATE_HTML, WEIGHT_SRC, DEFORM_SRC } from './core-assets.js';
import { projectRegions, PARAM_KEYS } from './regions.js';

/** _params.zoom is a factor; its slider is in percent. Mirrors BAKE_SCALE. */
const BAKE_SCALE = { zoom: 100 };

const PLACEHOLDERS = ['__IMAGE_BASE64__', '__REGIONS_JSON__', '__REGIONS_META_JSON__',
  '__WEIGHT_JS__', '__DEFORM_GLSL__', '__LS_SUFFIX__', '__BUILT__'];

/**
 * The page ships exactly one <script> block and the syntax gate below depends
 * on that. A second one would make this greedy pattern swallow the tags in
 * between and hand the parser something that is not valid JS.
 *
 * `\r?\n` because this side reads the template's own bytes while build_demo.py
 * reads it through pathlib, which decodes universal newlines. On Windows the
 * same file can therefore look LF to Python and CRLF here, and a regex anchored
 * on bare `\n` would simply not find the block -- reported as "the template has
 * two script blocks", which is not what happened.
 */
const SCRIPT_RE = /<script>\r?\n([\s\S]*)\r?\n<\/script>/;

export const DEFAULT_COMMENT =
  '区域配置：每个部位是一个枢轴加若干椭圆；每个椭圆有自己的幅度/速度/滞后，'
  + '所以同一部位里的两个椭圆可以错开摆。_params 是构建时烘焙进滑块的默认值。';

/** Python's `{val:g}` -- 6 significant digits, trailing zeros stripped. */
function g(v) {
  if (!isFinite(v)) return '0';
  return String(parseFloat(v.toPrecision(6)));
}

/**
 * Rewrite each slider's value= from the project's params.
 *
 * Baking at build time rather than branching at runtime is what keeps the built
 * page, its 重置 button and its built-in defaults in agreement with no special
 * casing -- the markup stays the single source of truth.
 */
export function bakeSliders(html, params) {
  const baked = [];
  const sliders = [];
  const out = html.replace(/<input[^>]*type="range"[^>]*>/g, tag => {
    const idm = /id="([\w-]+)"/.exec(tag);
    if (!idm) return tag;
    const key = idm[1];
    sliders.push(key);
    if (!(key in params)) return tag;
    const val = g(params[key] * (BAKE_SCALE[key] ?? 1));
    baked.push(`${key}=${val}`);
    return tag.replace(/value="[^"]*"/, () => `value="${val}"`);
  });
  return { html: out, baked, sliders };
}

/**
 * Refuse to inline a source that would break the page.
 *
 * Substituting source into a build is exactly where a stray `</script>` or an
 * unescaped backtick turns into a blank page at runtime, so it fails here.
 */
function guard(name, text, forbid) {
  for (const bad of forbid) {
    if (text.includes(bad)) {
      throw new Error(`core/${name} 含有 ${JSON.stringify(bad)}，无法内联进 demo.html。`);
    }
  }
  return text;
}

/** A localStorage-safe, human-recognisable suffix. CJK is legal in a key. */
export function slug(name) {
  const s = (name || '').trim().replace(/[^\w一-龥-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'untitled';
}

/**
 * @returns {{ html: string, baked: string[], stale: string[], bytes: number }}
 */
export function buildDemo({ name, imageBase64, regions, params, meta }) {
  let html = TEMPLATE_HTML;

  const bakedRes = bakeSliders(html, params);
  html = bakedRes.html;

  for (const ph of PLACEHOLDERS) {
    if (!html.includes(ph)) throw new Error(`模板缺少占位符 ${ph} —— tools/template.html 可能被改坏了。`);
  }

  // A misspelled _params key bakes nothing and says nothing; surface it.
  const stale = PARAM_KEYS.filter(k => !bakedRes.sliders.includes(k));

  // Every substitution goes through a function, never a string. Python's
  // str.replace has no special replacement syntax, but String.prototype.replace
  // expands `$&`, `$'` and friends -- so a `$` in a user's _comment or in the
  // shader source would be silently rewritten into template text. A function
  // replacement disables that interpretation entirely.
  html = html.replace('__IMAGE_BASE64__', () => imageBase64);
  html = html.replace('__REGIONS_JSON__', () => JSON.stringify(projectRegions(regions)));
  // The page rewrites this whole file on save, so it needs the "_" keys that
  // load_regions() drops. "<" is escaped so a _comment containing "</script>"
  // cannot terminate the inline script block.
  html = html.replace('__REGIONS_META_JSON__',
    () => JSON.stringify(meta).replace(/</g, '\\u003c'));
  html = html.replace('__WEIGHT_JS__', () => guard('region_field.js', WEIGHT_SRC, ['</script>']));
  // The shader lands inside a template literal, so it must not close or escape it.
  html = html.replace('__DEFORM_GLSL__', () => guard('deform.glsl', DEFORM_SRC, ['`', '${']));
  html = html.replace('__LS_SUFFIX__', () => `${slug(name)}-v1`);
  html = html.replace('"__BUILT__"', () => 'true');   // quotes included: replaces the literal

  const leftover = html.match(/__[A-Z_]+__/g);
  if (leftover) throw new Error(`还有占位符没有被替换：${[...new Set(leftover)].join(', ')}`);

  // A broken build should fail here, loudly, not as a blank page later. This is
  // the in-browser equivalent of the `node --check` gate in build_demo.py:
  // parsing without running catches exactly the same class of mistake.
  const m = SCRIPT_RE.exec(html);
  if (!m) throw new Error('无法提取 <script> 块（模板应当只有一段脚本）。');
  try {
    new Function(m[1]);
  } catch (e) {
    throw new Error('生成的脚本无法解析：' + e.message);
  }

  return {
    html,
    baked: bakedRes.baked,
    stale,
    bytes: new Blob([html]).size,
  };
}

/**
 * The project as a regions.json the Python pipeline can consume.
 *
 * Same shape the file already has, so the result goes straight back into
 * tools/build_demo.py. Region objects are carried through untouched -- rounding
 * c/r here would make save -> rebuild -> compare_equivalence drift.
 */
export function regionsJson({ meta, params, regions }) {
  const m = Object.prototype.hasOwnProperty.call(meta, '_comment')
    ? meta
    : { _comment: DEFAULT_COMMENT, ...meta };
  return JSON.stringify({
    ...m,
    _params: Object.fromEntries(PARAM_KEYS.map(k => [k, +params[k].toFixed(4)])),
    regions,
  }, null, 1);
}

/** Pull regions/params/meta back out of a regions.json. */
export function parseRegionsJson(text) {
  const raw = JSON.parse(text);
  // Handed back as the bare list; normalizeRegions() takes either that or the
  // whole file, so the file's own shape does not have to be decided here.
  const regions = Array.isArray(raw.regions) ? raw.regions : null;
  const params = raw._params || null;
  const meta = Object.fromEntries(Object.entries(raw).filter(([k]) => k.startsWith('_') && k !== '_params'));
  return { regions, params, meta };
}
