/**
 * The three files demo.html is built FROM, imported as text.
 *
 * tools/build_demo.py reads core/region_field.js, core/deform.glsl and
 * tools/template.html off disk and splices them into the deliverable. The app
 * does the same splice in a browser, so it pulls in the same bytes with Vite's
 * `?raw` rather than keeping a second copy that could drift.
 *
 * Importing from above app/ is why vite.config.js sets server.fs.allow.
 */
import TEMPLATE_HTML from '../../tools/template.html?raw';
import WEIGHT_SRC from '../../core/region_field.js?raw';
import DEFORM_SRC from '../../core/deform.glsl?raw';
import DEFAULT_REGIONS_JSON from '../../core/default_regions.json';

/**
 * region_field.js is UMD-lite: in a browser it assigns `self.DeformCore` and
 * returns nothing, so it cannot simply be `import`ed for a binding.
 *
 * Evaluating the same text the exporter inlines -- rather than re-exporting
 * whatever module Vite would build from that file -- is the point. It is the
 * only arrangement where the editor and the delivered demo are *provably*
 * running the same weight field, which is the invariant verify/test_weight_golden.js
 * pins to the Python oracle.
 */
new Function(WEIGHT_SRC)();

export const DeformCore = globalThis.DeformCore;

/** Falloff band constants, mirrored from the Python port (core/region_field.py). */
export const INNER = DeformCore.INNER;

export { TEMPLATE_HTML, WEIGHT_SRC, DEFORM_SRC, DEFAULT_REGIONS_JSON };
