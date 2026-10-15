import { createHash } from 'node:crypto';

/** JSON with sorted keys, so equal values always hash the same. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

export const hashOf = (v: unknown, len = 16) => createHash('sha256').update(stableStringify(v)).digest('hex').slice(0, len);
