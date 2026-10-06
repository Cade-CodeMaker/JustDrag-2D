/*
 * A small GIF89a reader, for tests only.
 *
 * Written by walking the block structure rather than searching for bytes:
 * 0x2C is the image separator, but it occurs freely inside LZW data and colour
 * tables, so counting occurrences would report nonsense frame counts on exactly
 * the frames that compress well.
 *
 * Only what the export tests need: geometry, per-frame delay and disposal, the
 * loop count, palette layout, and enough LZW to get frame 0 back as pixels.
 */

/** Read the sub-block chain that follows an image descriptor or extension. */
function readSubBlocks(b, p) {
  const parts = [];
  let total = 0;
  for (;;) {
    if (p >= b.length) throw new Error('gif: truncated sub-block chain');
    const n = b[p++];
    if (n === 0) break;
    if (p + n > b.length) throw new Error('gif: truncated sub-block');
    parts.push(b.subarray(p, p + n));
    total += n;
    p += n;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of parts) { out.set(part, o); o += part.length; }
  return [out, p];
}

const u16 = (b, p) => b[p] | (b[p + 1] << 8);

/** Table entry count from a packed field's low three bits. */
const tableLen = packed => 2 ** ((packed & 7) + 1);

function readTable(b, p, packed) {
  const n = tableLen(packed);
  const table = [];
  for (let i = 0; i < n; i++) {
    table.push([b[p + i * 3], b[p + i * 3 + 1], b[p + i * 3 + 2]]);
  }
  return [table, p + n * 3];
}

export function parseGif(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const sig = String.fromCharCode(...b.subarray(0, 6));
  if (sig !== 'GIF89a' && sig !== 'GIF87a') throw new Error(`gif: bad signature ${JSON.stringify(sig)}`);

  let p = 6;
  const screenWidth = u16(b, p);
  const screenHeight = u16(b, p + 2);
  const packed = b[p + 4];
  p += 7;

  let globalTable = null;
  if (packed & 0x80) [globalTable, p] = readTable(b, p, packed);

  const frames = [];
  let netscapeLoop = null;
  let pendingGce = null;
  let trailer = false;

  while (p < b.length) {
    const marker = b[p++];

    if (marker === 0x3B) { trailer = true; break; }

    if (marker === 0x21) {
      const label = b[p++];
      if (label === 0xF9) {
        const size = b[p++];
        const gcePacked = b[p];
        const delayCs = u16(b, p + 1);
        const transparentIndex = b[p + 3];
        // The extension is itself a block (size, then data) wrapped in a
        // sub-block chain ending in 0x00. Skipping only `size` bytes leaves
        // that terminator to be read as the next block marker.
        p = readSubBlocks(b, p + size)[1];
        pendingGce = {
          delayCs,
          transparent: Boolean(gcePacked & 1),
          transparentIndex,
          dispose: (gcePacked >> 2) & 7,
        };
      } else if (label === 0xFF) {
        const size = b[p++];
        const id = String.fromCharCode(...b.subarray(p, p + size));
        p += size;
        const [data, after] = readSubBlocks(b, p);
        p = after;
        if (id.startsWith('NETSCAPE2.0') && data[0] === 1) {
          netscapeLoop = data[1] | (data[2] << 8);
        }
      } else {
        p = readSubBlocks(b, p)[1];
      }
      continue;
    }

    if (marker === 0x2C) {
      const left = u16(b, p), top = u16(b, p + 2);
      const width = u16(b, p + 4), height = u16(b, p + 6);
      const imgPacked = b[p + 8];
      p += 9;

      let localTable = null;
      if (imgPacked & 0x80) [localTable, p] = readTable(b, p, imgPacked);

      const minCodeSize = b[p++];
      const [lzw, after] = readSubBlocks(b, p);
      p = after;

      frames.push({
        left, top, width, height,
        interlaced: Boolean(imgPacked & 0x40),
        localTable, minCodeSize, lzw,
        ...(pendingGce || { delayCs: 0, transparent: false, transparentIndex: 0, dispose: 0 }),
      });
      pendingGce = null;
      continue;
    }

    throw new Error(`gif: unknown block 0x${marker.toString(16)} at ${p - 1}`);
  }

  return {
    signature: sig, screenWidth, screenHeight,
    globalTable, frames, netscapeLoop, trailer,
    localTableCount: frames.filter(f => f.localTable).length,
  };
}

/**
 * GIF LZW, LSB-first, with the mid-stream code-width growth that trips up
 * naive decoders.
 */
function lzwDecode(data, minCodeSize, pixelCount) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out = new Uint8Array(pixelCount);

  let dict, next, codeSize, bitPos = 0, o = 0, prev = null;

  const reset = () => {
    dict = new Array(4096);
    for (let i = 0; i < clear; i++) dict[i] = [i];
    next = eoi + 1;
    codeSize = minCodeSize + 1;
  };
  reset();

  const readCode = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const byte = data[bitPos >> 3];
      if (byte === undefined) return -1;
      code |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return code;
  };

  while (o < pixelCount) {
    const code = readCode();
    if (code < 0) break;
    if (code === clear) { reset(); prev = null; continue; }
    if (code === eoi) break;

    let entry;
    if (code < next && dict[code]) entry = dict[code];
    else if (prev) entry = prev.concat(prev[0]);
    else break;

    for (let i = 0; i < entry.length && o < pixelCount; i++) out[o++] = entry[i];

    if (prev) {
      dict[next++] = prev.concat(entry[0]);
      if (next === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  return out;
}

/** Frame 0 as RGBA, using whichever colour table that frame resolves to. */
export function decodeFrame0(bytes) {
  const g = parseGif(bytes);
  const f = g.frames[0];
  if (!f) throw new Error('gif: no frames');
  const table = f.localTable || g.globalTable;
  if (!table) throw new Error('gif: frame 0 has no colour table');

  const idx = lzwDecode(f.lzw, f.minCodeSize, f.width * f.height);
  const rgba = new Uint8Array(f.width * f.height * 4);
  for (let i = 0; i < idx.length; i++) {
    const c = table[idx[i]] || [0, 0, 0];
    rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1];
    rgba[i * 4 + 2] = c[2]; rgba[i * 4 + 3] = 255;
  }
  return { width: f.width, height: f.height, rgba, delayCs: f.delayCs };
}
