import { gunzipSync, gzipSync } from 'node:zlib';
import { checkKey, type Store } from '@snjsm/workflow';

/**
 * The part of Forge KVS the workbench uses (see forge.ts for the real adapter). Kept narrow so the store can be
 * tested without the Forge runtime.
 */
export interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  getMany<T>(keys: string[]): Promise<Map<string, T>>;
  set(key: string, value: unknown, opts?: { ttlSeconds?: number }): Promise<void>;
  /** Set only when the key does not exist; false when it already does. Must be atomic. */
  setIfAbsent(key: string, value: unknown, opts?: { ttlSeconds?: number }): Promise<boolean>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  /** Keys starting with prefix (all pages), sorted. */
  keys(prefix: string): Promise<string[]>;
  /** Encrypted secret storage (Forge KVS secrets): never listed, never returned to the browser. */
  getSecret<T>(key: string): Promise<T | undefined>;
  setSecret(key: string, value: unknown): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

/** Forge KVS: keys match [a-zA-Z0-9:._\s-#]+ and are at most 500 characters; values at most 240 KiB. */
export const MAX_KEY = 500;
export const MAX_VALUE_BYTES = 240 * 1024;
/** Characters per chunk: JSON-encoded, a chunk stays well under MAX_VALUE_BYTES even for multi-byte text. */
export const CHUNK_CHARS = 48_000;

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** Encode a store key into the KVS alphabet. Prefix-preserving, so a key prefix maps to a KVS key prefix. */
export function encodeKey(key: string): string {
  // Fixed-width UTF-16 escapes (#002f for "/"), so encoding is unambiguous and prefix-preserving.
  return key.replace(/[^A-Za-z0-9._-]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
export function decodeKey(enc: string): string {
  return enc.replace(/#([0-9a-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** z: the stored payload is gzip + base64 of the value, zlen characters long (len is the value's length). */
interface Head { v: string; n: number; len: number; at: string; inline?: string; z?: 1; zlen?: number }
interface LockRecord { owner: string; at: string; until: string }

/**
 * Store on Forge KVS.
 *  - f:<key>          head: version, chunk count, length (small values are inline in the head)
 *                     Values too big to be inline are stored gzip + base64 (z in the head): blueprints and state files
 *                     shrink about tenfold, so a read costs a few chunks instead of dozens. Older uncompressed values
 *                     still read as before.
 *  - c:<key>:<v>:<i>  chunk i of version v
 *  - l:<key>          lock, created atomically (fail if it exists) with a TTL so a timed-out function cannot wedge it
 * A write puts the new version's chunks first and then swaps the head, so readers see the old value or the new one,
 * never a mix; the old version's chunks are deleted after the swap.
 */
export class KvStore implements Store {
  constructor(
    private readonly kv: Kv,
    private readonly opts: { lockSeconds?: number; now?: () => Date; id?: () => string } = {},
  ) {}

  private now() { return this.opts.now?.() ?? new Date(); }
  private id() { return this.opts.id?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }

  private enc(key: string): string {
    const e = encodeKey(checkKey(key));
    if (e.length + 40 > MAX_KEY) throw new Error(`storage key too long: ${key}`);
    return e;
  }

  async read(key: string): Promise<string | undefined> {
    const e = this.enc(key);
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = await this.kv.get<Head>(`f:${e}`);
      if (!head) return undefined;
      if (head.inline !== undefined) return this.decode(key, head, head.inline);
      const keys = Array.from({ length: head.n }, (_, i) => `c:${e}:${head.v}:${i}`);
      const got = await this.kv.getMany<string>(keys);
      if (keys.every((k) => got.has(k))) return this.decode(key, head, keys.map((k) => got.get(k)!).join(''));
      // A concurrent write swapped the head and removed these chunks: read the new head.
    }
    throw new Error(`stored value ${key} changed while it was read; try again`);
  }

  private decode(key: string, head: Head, payload: string): string {
    const corrupt = (got: number, want: number) => new Error(`stored value ${key} is corrupt (length ${got}, expected ${want})`);
    if (!head.z) {
      if (payload.length !== head.len) throw corrupt(payload.length, head.len);
      return payload;
    }
    if (payload.length !== head.zlen) throw corrupt(payload.length, head.zlen ?? 0);
    const text = gunzipSync(Buffer.from(payload, 'base64')).toString('utf8');
    if (text.length !== head.len) throw corrupt(text.length, head.len);
    return text;
  }

  /** The stored version of a value (one small read), to tell whether a copy read earlier is still current. */
  async stamp(key: string): Promise<string | undefined> {
    const head = await this.kv.get<Head>(`f:${this.enc(key)}`);
    return head ? `${head.v}:${head.len}` : undefined;
  }

  async write(key: string, text: string): Promise<void> {
    const e = this.enc(key);
    const prev = await this.kv.get<Head>(`f:${e}`);
    const head: Head = { v: this.id(), n: 0, len: text.length, at: this.now().toISOString() };
    if (text.length <= CHUNK_CHARS && bytes({ ...head, inline: text }) <= MAX_VALUE_BYTES) {
      head.inline = text;
    } else {
      const packed = gzipSync(Buffer.from(text, 'utf8')).toString('base64');
      head.z = 1;
      head.zlen = packed.length;
      const chunks: string[] = [];
      for (let i = 0; i < packed.length; i += CHUNK_CHARS) chunks.push(packed.slice(i, i + CHUNK_CHARS));
      for (const c of chunks) if (bytes(c) > MAX_VALUE_BYTES) throw new Error(`value ${key} has a chunk over the storage limit`);
      head.n = chunks.length;
      for (let i = 0; i < chunks.length; i += 20) {
        await Promise.all(chunks.slice(i, i + 20).map((c, j) => this.kv.set(`c:${e}:${head.v}:${i + j}`, c)));
      }
    }
    await this.kv.set(`f:${e}`, head);
    if (prev?.n) await this.kv.deleteMany(Array.from({ length: prev.n }, (_, i) => `c:${e}:${prev.v}:${i}`));
  }

  /** Remove a value and its chunks (used for temporary uploads). */
  async remove(key: string): Promise<void> {
    const e = this.enc(key);
    const prev = await this.kv.get<Head>(`f:${e}`);
    if (!prev) return;
    await this.kv.delete(`f:${e}`);
    if (prev.n) await this.kv.deleteMany(Array.from({ length: prev.n }, (_, i) => `c:${e}:${prev.v}:${i}`));
  }

  async list(prefix: string): Promise<string[]> {
    const p = encodeKey(prefix.replace(/\\/g, '/'));
    return (await this.kv.keys(`f:${p}`)).map((k) => decodeKey(k.slice(2))).filter((k) => k.startsWith(prefix)).sort();
  }

  async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = `l:${this.enc(key)}`;
    const seconds = this.opts.lockSeconds ?? 20 * 60;
    const now = this.now();
    const rec: LockRecord = { owner: this.id(), at: now.toISOString(), until: new Date(now.getTime() + seconds * 1000).toISOString() };
    if (!(await this.kv.setIfAbsent(lockKey, rec, { ttlSeconds: seconds }))) {
      const held = await this.kv.get<LockRecord>(lockKey);
      throw new Error(`state is locked by another run (${key}${held ? `, since ${held.at}, expires by ${held.until}` : ''}). Wait for it to finish.`);
    }
    try {
      return await fn();
    } finally {
      const held = await this.kv.get<LockRecord>(lockKey).catch(() => undefined);
      if (held?.owner === rec.owner) await this.kv.delete(lockKey).catch(() => undefined);
    }
  }
}

/** In-memory Kv with the same rules as Forge KVS (key alphabet, value size, atomic set-if-absent, TTL). For tests. */
export class MemoryKv implements Kv {
  readonly data = new Map<string, { value: unknown; expires?: number }>();
  ops = 0;
  constructor(private readonly clock: () => number = Date.now) {}

  private live(key: string) {
    const e = this.data.get(key);
    if (e && e.expires !== undefined && e.expires <= this.clock()) { this.data.delete(key); return undefined; }
    return e;
  }
  private check(key: string, value?: unknown) {
    if (!/^(?!\s+$)[a-zA-Z0-9:._\s\-#]+$/.test(key) || key.length > MAX_KEY) throw new Error(`invalid KVS key ${key}`);
    if (value !== undefined && bytes(value) > MAX_VALUE_BYTES) throw new Error(`KVS value too large for ${key}`);
  }
  async get<T>(key: string) { this.ops++; this.check(key); return this.live(key)?.value as T | undefined; }
  async getMany<T>(keys: string[]) {
    const out = new Map<string, T>();
    for (const k of keys) { const v = await this.get<T>(k); if (v !== undefined) out.set(k, v); }
    return out;
  }
  async set(key: string, value: unknown, o?: { ttlSeconds?: number }) {
    this.ops++; this.check(key, value);
    this.data.set(key, { value: structuredClone(value), ...(o?.ttlSeconds ? { expires: this.clock() + o.ttlSeconds * 1000 } : {}) });
  }
  async setIfAbsent(key: string, value: unknown, o?: { ttlSeconds?: number }) {
    if (this.live(key)) return false;
    await this.set(key, value, o);
    return true;
  }
  async delete(key: string) { this.ops++; this.check(key); this.data.delete(key); }
  async deleteMany(keys: string[]) { for (const k of keys) await this.delete(k); }
  async keys(prefix: string) { return [...this.data.keys()].filter((k) => k.startsWith(prefix) && this.live(k)).sort(); }
  readonly secrets = new Map<string, unknown>();
  async getSecret<T>(key: string) { this.check(key); return structuredClone(this.secrets.get(key)) as T | undefined; }
  async setSecret(key: string, value: unknown) { this.check(key, value); this.secrets.set(key, structuredClone(value)); }
  async deleteSecret(key: string) { this.check(key); this.secrets.delete(key); }
}
