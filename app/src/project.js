/**
 * Project storage, replacing the old "find assets/<name>/regions.json by hand"
 * workflow.
 *
 * A project is the whole working set -- source image, cut-out, regions, params
 * -- and it lives in IndexedDB so a refresh never loses anything. Two escape
 * hatches matter as much as the store itself:
 *
 *   .jd2d.json  a single portable file, so work is not trapped in one browser
 *   regions.json  the Python pipeline's format, for the round trip through tools/
 *
 * Image bytes are kept as ArrayBuffer + MIME rather than as Blob. Blobs in
 * IndexedDB are the documented shape, but older WebKit had bugs round-tripping
 * them, and an ArrayBuffer has no such history.
 */
import { bytesToBase64, base64ToBytes } from './imageutil.js';

const DB_NAME = 'justdrag';
const DB_VERSION = 1;
const STORE = 'projects';
const KV = 'kv';

export const FORMAT = 'justdrag-2d/project';
export const FORMAT_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, DB_VERSION);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error || new Error('无法打开本地数据库'));
    // A blocked upgrade means another tab pinned an older version. Better to
    // say so than to hang on a promise that will never settle.
    rq.onblocked = () => rej(new Error('另一个标签页正占用本地数据库，请关掉它再试。'));
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return openDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction(store, mode);
    const rq = fn(tx.objectStore(store));
    tx.oncomplete = () => res(rq ? rq.result : undefined);
    tx.onerror = tx.onabort = () => rej(tx.error || new Error('本地数据库读写失败'));
  }));
}

export function newId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Strip the (large) binary payloads -- a list only needs the label and thumbnail. */
export async function listProjects() {
  const all = await run(STORE, 'readonly', s => s.getAll());
  return all
    .map(p => ({ id: p.id, name: p.name, updated: p.updated, thumb: p.thumb, step: p.step,
                 hasCut: !!p.character }))
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

export const getProject = id => run(STORE, 'readonly', s => s.get(id));
export const putProject = rec => run(STORE, 'readwrite', s => s.put(rec));
export const deleteProject = id => run(STORE, 'readwrite', s => s.delete(id));

export const getKV = k => run(KV, 'readonly', s => s.get(k));
export const setKV = (k, v) => run(KV, 'readwrite', s => s.put(v, k));

// ------------------------------------------------------- portable file ---

/** The whole project as one downloadable JSON. */
export async function exportProjectFile(rec) {
  const out = {
    format: FORMAT,
    version: FORMAT_VERSION,
    name: rec.name,
    savedAt: new Date().toISOString(),
    regions: rec.regions,
    params: rec.params,
    meta: rec.meta,
    source: rec.source ? await blobToB64(rec.source) : null,
    character: rec.character ? await blobToB64(rec.character) : null,
  };
  return JSON.stringify(out, null, 1);
}

async function blobToB64(blob) {
  return { type: blob.type || 'image/png', data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) };
}

function b64ToBlob(part) {
  return new Blob([base64ToBytes(part.data)], { type: part.type || 'image/png' });
}

/** Parse a .jd2d.json back into a record ready for putProject(). */
export function importProjectFile(text) {
  const raw = JSON.parse(text);
  if (raw.format !== FORMAT) {
    throw new Error('这不是 JustDrag-2D 项目文件。');
  }
  if (raw.version > FORMAT_VERSION) {
    throw new Error(`项目文件版本 ${raw.version} 比当前应用新，请升级后再打开。`);
  }
  return {
    id: newId(),
    name: raw.name || '导入的项目',
    created: Date.now(),
    updated: Date.now(),
    step: 3,
    regions: raw.regions,
    params: raw.params,
    meta: raw.meta || {},
    source: raw.source ? b64ToBlob(raw.source) : null,
    character: raw.character ? b64ToBlob(raw.character) : null,
    thumb: null,
  };
}
