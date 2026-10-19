import { invoke } from '@forge/bridge';

/** Call a resolver function. The backend returns { ok, data } or { ok: false, error } so gate messages reach the person. */
export async function call<T = any>(name: string, payload?: Record<string, unknown>): Promise<T> {
  const r = (await invoke(name, payload ?? {})) as { ok: boolean; data?: T; error?: string } | undefined;
  if (!r || !r.ok) throw new Error(r?.error ?? `${name} failed`);
  return r.data as T;
}

export type Role = 'admin' | 'signer' | 'none';
export interface Settings { sandbox: { site: string; by: string; at: string } | null; signers: string[]; actAs: 'user' | 'app' }
export interface BlueprintEntry { id: string; name: string; customer: string; uploadedBy: string; uploadedAt: string; chars: number; outcomes: number; design: number; signedOff: boolean; source?: string }
export interface Boot { site: string; accountId: string; role: Role; designatePhrase: string; partChars: number; settings: Settings | null; writeAllowed: boolean; blueprints: BlueprintEntry[] }
export interface Job { id: string; op: 'dry-run' | 'verify' | 'apply' | 'collect'; blueprintId: string; by: string; status: 'queued' | 'running' | 'done' | 'failed'; queuedAt: string; startedAt?: string; finishedAt?: string; planHash?: string; result?: any; error?: string;
  step?: number; heartbeatAt?: string; progress?: { phase: string; index: number; total: number; pages: number; warnings: number; records?: number } }

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

export interface Connection {
  instance: string; grant: 'client_credentials' | 'password' | 'basic'; clientId: string; username?: string; scope?: string; customer: string; usageDays: number; requestsPerSecond: number;
  updatedBy: string; updatedAt: string;
  lastTest?: { ok: boolean; at: string; release?: string; checks: { name: string; ok: boolean; detail: string }[] };
}
export type Profile = 'oauth' | 'basic';
export type LogEntry =
  | { kind: 'http'; at: string; method: string; path: string; status?: number; ms: number; detail?: string; error?: string }
  | { kind: 'event'; at: string; level: 'info' | 'error'; message: string };
export interface ConnectionView { profile?: Profile; connection: Connection | null; hasClientSecret: boolean; hasPassword: boolean; nextBlueprintId: string | null; jobs: Job[] }

// Blueprint views (mirror src/views.ts on the backend).
export interface SnItem { id: string; kind: string; name: string; domain?: string; table?: string; intent?: string; custom?: boolean; active?: boolean; usage?: { count: number; periodDays?: number }; fillRate?: number; risk?: string }
export interface SnInventory {
  blueprintId: string; customer: string;
  sources: { kind: string; name: string; instance?: string; release?: string; addedAt: string }[];
  totals: { components: number; custom: number; inactive: number; scripted: number };
  categories: { id: string; label: string; count: number; custom: number; inactive: number; byKind: Record<string, number> }[];
}
export interface SnItemsPage { category: string; total: number; offset: number; items: SnItem[] }
export type Origin = 'reference' | 'reference-configured' | 'extension';
export type BuildMethod = 'automated' | 'automated + guided' | 'guided';
export interface JsmItem {
  id: string; type: string; name: string; origin: Origin; work: string; method: BuildMethod; guidedAspects: string[]; justification?: string; notes?: string;
  outcomes: { id: string; statement: string; status: string }[]; dependsOn: { id: string; name: string }[];
  replaces: { count: number; sample: { id: string; kind: string; name: string }[] };
}
export interface JsmGaps {
  blueprintId: string; customer: string;
  totals: { elements: number; standard: number; configure: number; custom: number; automated: number; partlyGuided: number; guided: number; gaps: number; outcomesWithoutElement: number };
  categories: { id: string; label: string; count: number; byOrigin: Record<Origin, number>; byMethod: Record<BuildMethod, number>; items: JsmItem[] }[];
  capabilities: { id: string; name: string; status: string; score?: number; counts?: { reference: number; configured: number; extension: number } }[];
  gaps: { capability: string; description: string; resolution: string; outcome?: string; evidence: string[] }[];
  outcomesWithoutElement: { id: string; statement: string; status: string }[];
}
