import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checkKey, type Store } from '@snjsm/workflow';

/**
 * Store backed by files under a work directory. Keys map to relative paths; anything that would resolve outside the
 * work directory (.., absolute paths, symlinks pointing out) is refused. Writes are atomic (temp file + rename) and
 * locks are `<key>.lock` files created exclusively, so two processes cannot hold the same lock.
 */
export class FsStore implements Store {
  constructor(readonly root: string) {}

  /** Absolute path for a key, refusing anything outside the work directory. */
  path(key: string): string {
    const root = existsSync(this.root) ? realpathSync(this.root) : this.root;
    const abs = resolve(root, key);
    // Resolve symlinks through the nearest existing ancestor, so a new file under a symlinked directory is caught too.
    let existing = abs;
    while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
    const real = join(realpathSync(existing), relative(existing, abs));
    const rel = relative(root, real);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path ${key} is outside the work directory ${this.root}`);
    return real;
  }

  async read(key: string): Promise<string | undefined> {
    const abs = this.path(checkKey(key));
    return existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
  }

  async write(key: string, text: string): Promise<void> {
    const abs = this.path(checkKey(key));
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}`;
    writeFileSync(tmp, text);
    renameSync(tmp, abs);
  }

  async list(prefix: string): Promise<string[]> {
    const p = prefix.replace(/\\/g, '/');
    const dirKey = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const dir = dirKey ? this.path(checkKey(dirKey)) : this.path('.');
    if (!existsSync(dir)) return [];
    const root = this.path('.');
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const abs = join(d, e.name);
        if (e.isDirectory()) walk(abs);
        else if (e.isFile() && !/\.(lock|tmp-\d+)$/.test(e.name)) {
          const key = relative(root, abs).split(sep).join('/');
          if (key.startsWith(p)) out.push(key);
        }
      }
    };
    walk(dir);
    return out.sort();
  }

  async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lock = `${this.path(checkKey(key))}.lock`;
    mkdirSync(dirname(lock), { recursive: true });
    let fd: number;
    try {
      fd = openSync(lock, 'wx');
    } catch {
      throw new Error(`state is locked by another run (${lock}). Delete the lock file only if no build is running.`);
    }
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    closeSync(fd);
    try {
      return await fn();
    } finally {
      try { unlinkSync(lock); } catch { /* already gone */ }
    }
  }
}
