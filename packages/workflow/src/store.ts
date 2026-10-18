/**
 * Where the workflow keeps blueprints, build state, plans, reviews and reports. Keys are relative POSIX paths such
 * as `state/<blueprint>@<host>.json`; implementations decide how to store them (files under a work directory, Forge
 * storage, memory). The workflow never touches a file system or network directly.
 */
export interface Store {
  /** The text stored under key, or undefined when there is none. */
  read(key: string): Promise<string | undefined>;
  /** Replace the text under key (atomically: a reader never sees half a value). */
  write(key: string, text: string): Promise<void>;
  /** Keys directly or indirectly under a prefix such as `state/`, sorted. */
  list(prefix: string): Promise<string[]>;
  /**
   * Run fn while holding an exclusive lock named key. A second holder must be refused (not queued), with an error
   * that says what is locked, so two applies can never run against the same state.
   */
  lock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/** Keys must be relative paths without `..`, absolute parts or empty segments. */
export function checkKey(key: string): string {
  const k = key.replace(/\\/g, '/');
  if (!k || k.startsWith('/') || /^[a-z]:/i.test(k) || k.split('/').some((p) => p === '' || p === '.' || p === '..')) throw new Error(`invalid storage key ${key}`);
  return k;
}

/** In-memory store, for tests and for one-shot use. */
export class MemoryStore implements Store {
  readonly data = new Map<string, string>();
  private readonly locks = new Set<string>();

  async read(key: string) { return this.data.get(checkKey(key)); }
  async write(key: string, text: string) { this.data.set(checkKey(key), text); }
  async list(prefix: string) { return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort(); }
  async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const k = checkKey(key);
    if (this.locks.has(k)) throw new Error(`state is locked by another run (${k})`);
    this.locks.add(k);
    try { return await fn(); } finally { this.locks.delete(k); }
  }
}
