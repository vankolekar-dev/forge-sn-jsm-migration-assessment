import { invoke } from '@forge/bridge';

/** Call a resolver function. The backend returns { ok, data } or { ok: false, error } so gate messages reach the person. */
export async function call<T = any>(name: string, payload?: Record<string, unknown>): Promise<T> {
  const r = (await invoke(name, payload ?? {})) as { ok: boolean; data?: T; error?: string } | undefined;
  if (!r || !r.ok) throw new Error(r?.error ?? `${name} failed`);
  return r.data as T;
}

export type Role = 'admin' | 'signer' | 'none';
export interface Settings { sandbox: { site: string; by: string; at: string } | null; signers: string[]; actAs: 'user' | 'app' }
export interface BlueprintEntry { id: string; name: string; customer: string; uploadedBy: string; uploadedAt: string; chars: number; outcomes: number; design: number; signedOff: boolean }
export interface Boot { site: string; accountId: string; role: Role; designatePhrase: string; partChars: number; settings: Settings | null; writeAllowed: boolean; blueprints: BlueprintEntry[] }
export interface Job { id: string; op: 'dry-run' | 'verify' | 'apply'; blueprintId: string; by: string; status: 'queued' | 'running' | 'done' | 'failed'; queuedAt: string; startedAt?: string; finishedAt?: string; planHash?: string; result?: any; error?: string }

/** Upload a blueprint file in parts of the server's size, four at a time, then let the server validate and store it. */
export async function uploadBlueprint(text: string, fileName: string, partChars: number, replace: boolean, onProgress: (done: number, total: number) => void) {
  const parts = Math.ceil(text.length / partChars);
  const { uploadId } = await call<{ uploadId: string }>('uploadStart', { fileName, chars: text.length, parts });
  let done = 0;
  const queue = Array.from({ length: parts }, (_, i) => i);
  const worker = async () => {
    for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
      await call('uploadPart', { uploadId, index: i, text: text.slice(i * partChars, (i + 1) * partChars) });
      onProgress(++done, parts);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return call<{ blueprintId: string; replaced: boolean }>('uploadFinish', { uploadId, replace });
}
