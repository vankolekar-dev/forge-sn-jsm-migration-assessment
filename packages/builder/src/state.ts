import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BuildState } from './types';

export function newState(blueprintId: string, site: string, now = new Date().toISOString()): BuildState {
  return { schemaVersion: '1', blueprintId, site, createdAt: now, updatedAt: now, elements: {}, runs: [] };
}

export function readState(path: string): BuildState | undefined {
  if (!existsSync(path)) return undefined;
  const s = JSON.parse(readFileSync(path, 'utf8')) as BuildState;
  if (s.schemaVersion !== '1') throw new Error(`unsupported state file version ${s.schemaVersion}`);
  return s;
}

/** Atomic write (temp file + rename): a crash never leaves a half-written state file. */
export function writeState(path: string, s: BuildState): void {
  mkdirSync(dirname(path), { recursive: true });
  s.updatedAt = new Date().toISOString();
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, path);
}

/** Exclusive lock next to the state file so two applies cannot run against the same state. */
export async function withLock<T>(statePath: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${statePath}.lock`;
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

/** The state belongs to one blueprint and one site; refuse to mix them up. */
export function assertStateMatches(s: BuildState, blueprintId: string, site: string): void {
  if (s.blueprintId !== blueprintId) throw new Error(`state file is for blueprint ${s.blueprintId}, not ${blueprintId}`);
  if (s.site !== site) throw new Error(`state file is pinned to ${s.site}, not ${site}`);
}
