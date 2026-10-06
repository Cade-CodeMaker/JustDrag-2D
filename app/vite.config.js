import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'ort');

/**
 * Serve onnxruntime-web's runtime files straight off disk.
 *
 * `public/` is the right home for them -- a production build copies it verbatim,
 * which is exactly what a runtime-loaded .wasm wants. But in dev, Vite refuses
 * to let source code `import()` anything under public/ ("should not be imported
 * from source code. It can only be referenced via HTML tags"), and ORT reaches
 * for its .wasm with a dynamic import through `ort.env.wasm.wasmPaths`.
 *
 * A `configureServer` middleware runs BEFORE the internal transform middleware,
 * so registering it here answers the request with the raw bytes and the dynamic
 * import never enters Vite's pipeline at all. The `?import` suffix Vite appends
 * is dropped for the same reason.
 */
/**
 * The app builds demo.html itself now, so it has to read the same three files
 * tools/build_demo.py does: core/region_field.js, core/deform.glsl and
 * tools/template.html. They are `?raw`-imported, which means Vite must be
 * allowed to serve paths above app/ -- the dev server otherwise answers with a
 * 403 and the app dies at import time.
 */
const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export default {
  server: {
    fs: { allow: [PROJECT_ROOT] },
  },
  plugins: [
    {
      name: 'serve-ort-runtime',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = (req.url || '').split('?')[0];
          if (!url.startsWith('/ort/')) return next();

          const file = path.join(ORT_DIR, path.basename(url));
          if (!fs.existsSync(file)) return next();

          res.setHeader('Content-Type',
            url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
          fs.createReadStream(file).pipe(res);
        });
      },
    },
  ],
};
