/**
 * Canvas and encoding helpers.
 *
 * All of these are the boring half of moving bytes around: an image in, a PNG
 * out, base64 either way. They are collected here so the pipeline modules can
 * read as pipeline.
 */

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Anything drawable -> something with .width/.height that texImage2D accepts.
 *
 * createImageBitmap is the fast path. The <img> fallback is not paranoia:
 * older Safari refuses createImageBitmap on Blob, and a raw failure here would
 * present as "选好图片后什么都没发生".
 */
export async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob); } catch (_) { /* fall through */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('图片无法解码，可能不是有效的 PNG/JPEG。'));
      img.src = url;
    });
  } finally {
    // The bitmap is already decoded into the element; the URL is not needed.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * The cut-out as an RGBA canvas: bled colour, ORIGINAL alpha.
 *
 * `res.alpha` and not the mask grown inside bleed() -- that one only tracks how
 * far colour has spread, and using it would erase the character's soft edge.
 * This is byte-for-byte what character_*.png holds on the Python side.
 */
export function cutoutToCanvas(res) {
  const { width: w, height: h, rgb, alpha } = res;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(w, h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    img.data[i] = rgb[p * 3];
    img.data[i + 1] = rgb[p * 3 + 1];
    img.data[i + 2] = rgb[p * 3 + 2];
    img.data[i + 3] = alpha[p];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((res, rej) => {
    canvas.toBlob(b => (b ? res(b) : rej(new Error('画布导出失败'))), type, quality);
  });
}

/**
 * base64 in chunks.
 *
 * The obvious `btoa(String.fromCharCode(...bytes))` blows the argument limit on
 * a multi-megabyte PNG, which is exactly the size these are.
 */
export function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let s = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const blobToBase64 = async blob => bytesToBase64(new Uint8Array(await blob.arrayBuffer()));

/** A small preview for the project list. JPEG keeps it a few KB. */
export async function makeThumb(source, max = 240) {
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const s = Math.min(1, max / Math.max(w, h));
  const c = makeCanvas(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  // The character is transparent; a mid grey reads better than black in a list.
  ctx.fillStyle = '#3a3f4a';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(source, 0, 0, c.width, c.height);
  const blob = await canvasToBlob(c, 'image/jpeg', 0.72);
  return 'data:image/jpeg;base64,' + await blobToBase64(blob);
}

/** Hand a Blob to the browser as a download. */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some builds; one tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
