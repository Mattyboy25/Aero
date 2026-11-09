// Generated audio clips are too big for localStorage, so they live in IndexedDB, keyed by clip id.
// The clip list itself (times, text) is saved with the project as usual.

const DB_NAME = "aero-audio";
const STORE = "clips";

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then((d) => new Promise<T | undefined>((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const putClip = (id: string, blob: Blob) => run("readwrite", (s) => s.put(blob, id)).then(() => undefined);
export const getClip = (id: string) => run<Blob | undefined>("readonly", (s) => s.get(id)).catch(() => undefined);
export async function deleteClips(ids: string[]) {
  if (!ids.length) return;
  try { await run("readwrite", (s) => { ids.forEach((id) => s.delete(id)); }); } catch { /* best effort */ }
}
