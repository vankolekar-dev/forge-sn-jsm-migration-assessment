import { describe, expect, it } from 'vitest';
import { CHUNK_CHARS, decodeKey, encodeKey, KvStore, MemoryKv } from '../src/kv-store';

describe('KVS store', () => {
  it('encodes keys into the KVS alphabet, reversibly and prefix-preserving', () => {
    const k = 'state/bp.fixture-co.2026-10-18@one-atlas-vish.atlassian.net.json';
    const e = encodeKey(k);
    expect(e).toMatch(/^[a-zA-Z0-9:._\-#]+$/);
    expect(decodeKey(e)).toBe(k);
    expect(e.startsWith(encodeKey('state/'))).toBe(true);
    expect(decodeKey(encodeKey('a:b #c/é'))).toBe('a:b #c/é');
    expect(encodeKey('a#002f')).not.toBe(encodeKey('a/'));
  });

  it('stores small values inline and large ones in chunks under the value limit, and swaps versions cleanly', async () => {
    const kv = new MemoryKv();
    const store = new KvStore(kv);
    await store.write('index/x.json', '{"a":1}');
    expect(await store.read('index/x.json')).toBe('{"a":1}');
    expect([...kv.data.keys()].filter((k) => k.startsWith('c:'))).toEqual([]);

    const big = `${'é€😀'.repeat(400_000)}end`; // multi-byte, ~2.4 M UTF-16 units: chunked
    await store.write('blueprints/bp.json', big);
    expect(await store.read('blueprints/bp.json')).toBe(big);
    const chunks1 = [...kv.data.keys()].filter((k) => k.startsWith('c:'));
    expect(chunks1.length).toBe(Math.ceil(big.length / CHUNK_CHARS));

    await store.write('blueprints/bp.json', 'small now');
    expect(await store.read('blueprints/bp.json')).toBe('small now');
    expect([...kv.data.keys()].filter((k) => k.startsWith('c:'))).toEqual([]); // old version removed
    await store.remove('blueprints/bp.json');
    expect(await store.read('blueprints/bp.json')).toBeUndefined();
  });

  it('lists by prefix (keys with / and @) and refuses unsafe keys', async () => {
    const store = new KvStore(new MemoryKv());
    await store.write('state/a@site.atlassian.net.json', '1');
    await store.write('state/b@site.atlassian.net.json', '2');
    await store.write('plans/a.md', '3');
    expect(await store.list('state/')).toEqual(['state/a@site.atlassian.net.json', 'state/b@site.atlassian.net.json']);
    expect(await store.list('state/b')).toEqual(['state/b@site.atlassian.net.json']);
    await expect(store.read('../x')).rejects.toThrow(/invalid storage key/);
    await expect(store.write(`plans/${'x'.repeat(480)}`, '1')).rejects.toThrow(/too long/);
  });

  it('locks atomically, refuses a second holder, and a timed-out lock expires', async () => {
    let t = Date.parse('2026-10-18T12:00:00Z');
    const kv = new MemoryKv(() => t);
    const store = new KvStore(kv, { lockSeconds: 60, now: () => new Date(t) });
    await expect(store.lock('state/a.json', async () => store.lock('state/a.json', async () => 1))).rejects.toThrow(/locked by another run.*expires by/);
    expect(await store.lock('state/a.json', async () => 2)).toBe(2); // released after use

    // A crashed holder never releases; the TTL frees the lock.
    await kv.setIfAbsent(`l:${encodeKey('state/b.json')}`, { owner: 'dead', at: new Date(t).toISOString(), until: '' }, { ttlSeconds: 60 });
    await expect(store.lock('state/b.json', async () => 3)).rejects.toThrow(/locked/);
    t += 61_000;
    expect(await store.lock('state/b.json', async () => 4)).toBe(4);
  });
});
