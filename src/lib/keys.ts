import { useCallback, useEffect, useRef, useState } from "react";

// The user's own API keys. They are:
// - encrypted (AES-GCM) before they touch localStorage, with a non-extractable key kept in
//   IndexedDB, so a copy of the stored data on its own can't be read;
// - kept in memory while the app runs, and sent only in request headers to this app's server;
// - never shown in full after they're saved.
// If the browser can't encrypt (for example on a plain-HTTP address that isn't localhost), keys
// are kept in memory only and forgotten when the tab closes.

export type Provider = "anthropic" | "elevenlabs";
export const PROVIDERS: Provider[] = ["anthropic", "elevenlabs"];

export type CheckStatus = "valid" | "invalid" | "unknown";
export interface CheckResult { status: CheckStatus; message: string }

const storageName = (p: Provider) => `aero.secret.${p}`;
const DB_NAME = "aero-secure";
const STORE = "kv";
const MASTER = "master-key";

const canEncrypt = () => typeof crypto !== "undefined" && !!crypto.subtle && typeof indexedDB !== "undefined";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function masterKey(create: boolean): Promise<CryptoKey | null> {
  let key = await idb<CryptoKey | undefined>("readonly", (s) => s.get(MASTER));
  if (!key && create) {
    key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await idb("readwrite", (s) => s.put(key, MASTER));
  }
  return key ?? null;
}

const toB64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function encrypt(plain: string): Promise<string> {
  const key = (await masterKey(true))!;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return JSON.stringify({ v: 1, iv: toB64(iv), data: toB64(data) });
}

async function decrypt(stored: string): Promise<string | null> {
  try {
    const { iv, data } = JSON.parse(stored);
    const key = await masterKey(false);
    if (!key) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, key, fromB64(data));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

export const maskKey = (key: string) => `••••••••${key.slice(-4)}`;

export interface ApiKeys {
  /** Decrypted keys, or null when not set. */
  keys: Record<Provider, string | null>;
  /** False until the saved keys have been read back, so the UI doesn't flash "no key". */
  ready: boolean;
  /** False when this browser can't encrypt, so keys only last until the tab closes. */
  persistent: boolean;
  /** The current key for a provider, for use inside async code. */
  get: (p: Provider) => string | null;
  save: (p: Provider, value: string) => Promise<void>;
  remove: (p: Provider) => Promise<void>;
}

export function useApiKeys(): ApiKeys {
  const [keys, setKeys] = useState<Record<Provider, string | null>>({ anthropic: null, elevenlabs: null });
  const [ready, setReady] = useState(false);
  const persistent = canEncrypt();
  const ref = useRef(keys);
  ref.current = keys;

  useEffect(() => {
    let alive = true;
    (async () => {
      const next: Record<Provider, string | null> = { anthropic: null, elevenlabs: null };
      if (persistent) {
        for (const p of PROVIDERS) {
          try {
            const stored = localStorage.getItem(storageName(p));
            if (stored) next[p] = await decrypt(stored);
          } catch { /* unreadable: treat as not set */ }
        }
      }
      if (alive) { setKeys((cur) => ({ anthropic: cur.anthropic ?? next.anthropic, elevenlabs: cur.elevenlabs ?? next.elevenlabs })); setReady(true); }
    })();
    return () => { alive = false; };
  }, [persistent]);

  const save = useCallback(async (p: Provider, value: string) => {
    const v = value.trim();
    if (persistent) {
      try { localStorage.setItem(storageName(p), await encrypt(v)); } catch { /* keep it in memory only */ }
    }
    setKeys((cur) => ({ ...cur, [p]: v }));
  }, [persistent]);

  const remove = useCallback(async (p: Provider) => {
    try { localStorage.removeItem(storageName(p)); } catch { /* ignore */ }
    setKeys((cur) => ({ ...cur, [p]: null }));
  }, []);

  const get = useCallback((p: Provider) => ref.current[p], []);
  return { keys, ready, persistent, get, save, remove };
}

// Asks the server to check a key with its provider. The key goes in a header, never a URL.
export async function checkKey(p: Provider, key: string): Promise<CheckResult> {
  try {
    const res = await fetch(`/api/keys/check/${p}`, { method: "POST", headers: { [KEY_HEADERS[p]]: key } });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } catch {
    return { status: "unknown", message: "Couldn't check this key right now. It was saved." };
  }
}

export const KEY_HEADERS: Record<Provider, string> = {
  anthropic: "x-anthropic-key",
  elevenlabs: "x-elevenlabs-key",
};
