import { z } from 'zod';
import type { Blueprint } from '@snjsm/model';
import { isSignedOff, type SiteApi } from '@snjsm/builder';
import { BuildService, parseBlueprint, safeName, hostOf, type ServiceConfig, type Store } from '@snjsm/workflow';
import {
  BasicAuthProvider, ClientCredentialsProvider, ServiceNowError, PasswordGrantProvider, loggingFetch, type RequestLogEntry, STANDARD_PULLS, ServiceNowClient, collectSteps, standardAggregates, normaliseInstanceUrl, snapshotOf, startCursor, CURSOR_VERSION,
  type Aggregate, type TablePull, type CollectCursor, type CollectSink, type HttpFetch, type SnRecord, type TokenProvider,
} from '@snjsm/collector';
import { analyse, blueprintIdFor, extractPage, mergeExtractions, streamContext, stubOf, type ExtractContext, type PreExtracted, type StreamSource, type TableExtraction } from '@snjsm/analyser';
import { gunzipSync, gzipSync } from 'node:zlib';
import { CHUNK_CHARS, KvStore, type Kv } from './kv-store';
import { jsmGaps, snInventory, snItems } from './views';

/**
 * The workbench backend, independent of the Forge runtime (index.ts wires it to Forge). Every gate of the build
 * workflow stays in @snjsm/workflow; this layer adds what a shared, multi-user app needs:
 *  - identity and site come from the Forge runtime (accountId, install context), never from the browser;
 *  - roles are checked server-side on every call: Jira admins do everything, listed signers may read and sign off,
 *    anyone else is refused;
 *  - writes are only possible on this site after a Jira admin designated it as a sandbox by typing
 *    "DESIGNATE <host> AS SANDBOX"; sign-off is never optional here (allowUnsigned is always false);
 *  - an uploaded blueprint never brings a sign-off with it: a carried sign-off is made stale by a recorded change, so
 *    the outcomes are signed off again here, by a person identified by Forge;
 *  - dry-run, verify and apply run as queued jobs (no 25 s resolver limit), at most one at a time per blueprint, and a
 *    retried event never re-runs an apply.
 */

export type Role = 'admin' | 'signer' | 'none';
export type Actor = { as: 'user'; accountId: string } | { as: 'app' };
export type JobOp = 'dry-run' | 'verify' | 'apply' | 'collect';

export interface Caller { accountId: string; siteUrl: string; cloudId: string }

export interface Settings {
  /** The site writes are allowed on (always this site), and who designated it when. */
  sandbox: { site: string; by: string; at: string } | null;
  /** Account ids allowed to read and sign off besides Jira admins. */
  signers: string[];
  /** Who queued jobs act as on the site: the person who queued them (default) or the app. */
  actAs: 'user' | 'app';
}
const DEFAULT_SETTINGS: Settings = { sandbox: null, signers: [], actAs: 'user' };

export interface Platform {
  kv: Kv;
  /** Egress to ServiceNow instances (allowed hosts are fixed in the manifest). */
  snFetch: HttpFetch;
  /** Rate-limit and back-off waits for ServiceNow calls (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** A client for this site acting as actor. */
  client(actor: Actor, readOnly: boolean): SiteApi;
  /** Whether the calling user is a Jira administrator (checked as that user). */
  isAdmin(): Promise<boolean>;
  /** Queue a job; jobs with the same concurrency key run one at a time. */
  /** Queue a job message; `delaySeconds` (max 900) defers it, used to back off from platform limits. */
  enqueue(msg: JobMessage, concurrencyKey: string, delaySeconds?: number): Promise<void>;
  now?(): Date;
}

export interface JobMessage { jobId: string; blueprintId: string; [k: string]: unknown }

export interface Progress { phase: CollectCursor['phase']; index: number; total: number; pages: number; warnings: number; records?: number }

export interface Job {
  id: string; op: JobOp; blueprintId: string; by: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  queuedAt: string; startedAt?: string; finishedAt?: string;
  planHash?: string; confirm?: string;
  scope?: { capabilityIds?: string[]; elementIds?: string[] };
  result?: unknown; error?: string;
  /** Collect jobs run as a chain of invocations: the step expected next, the last sign of life, and progress. */
  step?: number; heartbeatAt?: string;
  /** Within the phase: item `index` of `total` (pulls, aggregates or CI classes); `records` only once done. */
  progress?: Progress;
  /** Times this collection backed off from a platform limit (reset on each step that moves). */
  limitRetries?: number;
  /** Set while waiting out a platform limit. */
  waitingUntil?: string;
  collect?: { customer: string; instance: string; replace: boolean; profile?: Profile };
}

/** ServiceNow connection: what is shown to admins. The client secret and password live in secret storage only. */
export interface Connection {
  instance: string;
  grant: 'client_credentials' | 'password' | 'basic';
  clientId: string;
  username?: string;
  scope?: string;
  customer: string;
  usageDays: number;
  requestsPerSecond: number;
  updatedBy: string; updatedAt: string;
  lastTest?: { ok: boolean; at: string; release?: string; checks: { name: string; ok: boolean; detail: string }[] };
}
interface ConnectionSecret { clientSecret?: string; password?: string }

/**
 * Two independent connections: OAuth for customer instances, and basic auth (user name and password) for demos and
 * developer instances. Each has its own record, secret and request log; the OAuth keys predate profiles.
 */
export type Profile = 'oauth' | 'basic';
const PROFILES: Record<Profile, { conn: string; secret: string; log: string }> = {
  oauth: { conn: 'sn-connection', secret: 'sn-secret', log: 'logs/sn-oauth.json' },
  basic: { conn: 'sn-connection-basic', secret: 'sn-secret-basic', log: 'logs/sn-basic.json' },
};

/** A ServiceNow request (`kind: 'http'`) or a workbench event, newest last. */
export type LogEntry = ({ kind: 'http' } & RequestLogEntry) | { kind: 'event'; at: string; level: 'info' | 'error'; message: string };
const LOG_KEEP = 250;
const LOG_FLUSH_MS = 30_000;

/** Buffers log entries in memory and appends them to the stored ring when flushed (each flush is one write). */
class SnLog {
  private pending: LogEntry[] = [];
  private lastFlush: number;
  constructor(private readonly store: Store, private readonly key: string, private readonly now: () => number) { this.lastFlush = now(); }
  http = (e: RequestLogEntry) => { this.pending.push({ kind: 'http', ...e }); };
  event(message: string, level: 'info' | 'error' = 'info') { this.pending.push({ kind: 'event', at: new Date(this.now()).toISOString(), level, message }); }
  async flush(force = true) {
    if (!this.pending.length || (!force && this.now() - this.lastFlush < LOG_FLUSH_MS)) return;
    const batch = this.pending; this.pending = []; this.lastFlush = this.now();
    try {
      const prev = JSON.parse((await this.store.read(this.key)) ?? '[]') as LogEntry[];
      await this.store.write(this.key, JSON.stringify([...prev, ...batch].slice(-LOG_KEEP)));
    } catch { /* diagnostics must never break a test or a collection */ }
  }
}

/** Jobs that collect from ServiceNow are listed under this pseudo blueprint id. */
export const COLLECT = 'sn-collect';

export const designatePhrase = (site: string) => `DESIGNATE ${hostOf(site)} AS SANDBOX`;

const MAX_UPLOAD_CHARS = 20_000_000;
/** Work per collect invocation, well inside the consumer's 900 s limit (pages, writes and analysis need headroom). */
const COLLECT_BUDGET_MS = 600_000;
const UPLOAD_TTL = 3600;
const KEEP_JOBS = 30;
/** Longer than the consumer's 900 s limit plus queue delay; equals the default state lock TTL. */
const JOB_STALE_MS = 20 * 60_000;

// ── payloads (everything from the browser is validated) ──────────────────────

const id = z.string().min(1).max(200).regex(/^[\w.@-]+$/);
const accountId = z.string().min(1).max(128).regex(/^[\w:-]+$/);
const scope = { capabilityIds: z.array(z.string().max(200)).max(200).optional(), elementIds: z.array(z.string().max(200)).max(500).optional() };
const P = {
  blueprint: z.object({ blueprintId: id }),
  inventoryItems: z.object({ blueprintId: id, category: z.string().max(40), query: z.string().max(200).optional(), customOnly: z.boolean().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional() }),
  uploadStart: z.object({ fileName: z.string().max(300), chars: z.number().int().positive().max(MAX_UPLOAD_CHARS), parts: z.number().int().positive().max(Math.ceil(MAX_UPLOAD_CHARS / CHUNK_CHARS)) }),
  uploadPart: z.object({ uploadId: id, index: z.number().int().min(0), text: z.string().max(CHUNK_CHARS) }),
  uploadFinish: z.object({ uploadId: id, replace: z.boolean().optional() }),
  setSpace: z.object({ blueprintId: id, designId: z.string().max(200).optional(), mode: z.enum(['new', 'existing']), key: z.string().max(10).optional(), name: z.string().max(200).optional(), reason: z.string().max(2000).optional() }),
  signOff: z.object({ blueprintId: id, signHash: z.string().regex(/^[0-9a-f]{8,64}$/), confirm: z.string().max(400), reject: z.array(z.string().max(200)).max(200).optional(), defer: z.array(z.string().max(200)).max(200).optional(), reinstate: z.array(z.string().max(200)).max(200).optional(), comment: z.string().max(2000).optional() }),
  startJob: z.object({ blueprintId: id, op: z.enum(['dry-run', 'verify', 'apply']), planHash: z.string().regex(/^[0-9a-f]{8,64}$/).optional(), confirm: z.string().max(400).optional(), ...scope }),
  job: z.object({ blueprintId: id, jobId: id }),
  confirmManual: z.object({ blueprintId: id, designId: z.string().max(200), remoteId: z.string().max(200).optional(), remoteKey: z.string().max(200).optional(), note: z.string().max(2000).optional() }),
  report: z.object({ key: z.string().max(400) }),
  acceptancePlan: z.object({ blueprintId: id, outcomeIds: z.array(z.string().max(200)).max(200).optional() }),
  connection: z.object({
    profile: z.literal('oauth').optional(),
    instance: z.string().min(3).max(200),
    grant: z.enum(['client_credentials', 'password']),
    clientId: z.string().min(1).max(200),
    clientSecret: z.string().max(500).optional(),
    username: z.string().max(200).optional(),
    /** OAuth scope to request; only for integrations that restrict auth scopes (usually `useraccount`). */
    scope: z.string().regex(/^[\w.:\- ]{0,200}$/, 'scope: letters, digits, . : - and spaces only').optional(),
    password: z.string().max(500).optional(),
    /** Shown on the blueprint and in its id; defaults to the instance name. */
    customer: z.string().max(120).optional(),
    usageDays: z.number().int().min(1).max(1095).optional(),
    requestsPerSecond: z.number().min(0.5).max(10).optional(),
  }),
  basicConnection: z.object({
    profile: z.literal('basic'),
    instance: z.string().min(3).max(200),
    username: z.string().min(1).max(200),
    password: z.string().max(500).optional(),
    customer: z.string().max(120).optional(),
    usageDays: z.number().int().min(1).max(1095).optional(),
    requestsPerSecond: z.number().min(0.5).max(10).optional(),
  }),
  profile: z.object({ profile: z.enum(['oauth', 'basic']).optional() }),
  collect: z.object({ replace: z.boolean().optional(), profile: z.enum(['oauth', 'basic']).optional() }),
  resume: z.object({ jobId: id }),
  settings: z.object({
    signers: z.array(accountId).max(100).optional(),
    actAs: z.enum(['user', 'app']).optional(),
    sandbox: z.discriminatedUnion('designate', [z.object({ designate: z.literal(true), confirm: z.string().max(200) }), z.object({ designate: z.literal(false) })]).optional(),
  }),
};

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const r = schema.safeParse(payload ?? {});
  if (!r.success) throw new Error(`invalid request: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`).join('; ')}`);
  return r.data;
}

const bpKey = (blueprintId: string) => `blueprints/${safeName(blueprintId)}.json`;
const jobsPrefix = (blueprintId: string) => `jobs/${safeName(blueprintId)}/`;

interface IndexEntry { id: string; name: string; customer: string; uploadedBy: string; uploadedAt: string; chars: number; outcomes: number; design: number; signedOff: boolean; source?: string }

/**
 * Collected pages in app storage, gzip-compressed (ServiceNow JSON shrinks several-fold) and keyed per table:
 * - p/: whole records of the context tables (read by the analysis of other records);
 * - i/: name indexes (only for analysing streamed pages);
 * - e/: streamed pages, already turned into evidence, with a small stub per record instead of the record.
 * Context tables and indexes are pulled before streamed tables, so the first streamed page of an invocation builds
 * the lookup context once. Writing the same page again overwrites it, so replaying from an older cursor is safe.
 */
interface EvidencePage { stubs: SnRecord[]; tables: [string, TableExtraction][] }

class StoreSink implements CollectSink {
  private ctx?: ExtractContext;
  constructor(private readonly store: KvStore, private readonly prefix: string, private readonly src: StreamSource) {}
  private key(kind: 'p' | 'i' | 'e', table: string, n: number) { return `${this.prefix}${kind}/${table}/${String(n).padStart(6, '0')}.gz`; }
  private async put(k: string, v: unknown) { await this.store.write(k, gzipSync(Buffer.from(JSON.stringify(v), 'utf8')).toString('base64')); }
  private async get<T>(k: string): Promise<T | undefined> {
    const t = await this.store.read(k);
    return t ? (JSON.parse(gunzipSync(Buffer.from(t, 'base64')).toString('utf8')) as T) : undefined;
  }
  private async pages<T>(kind: 'p' | 'i' | 'e'): Promise<T[]> {
    const out: T[] = [];
    for (const k of await this.store.list(`${this.prefix}${kind}/`)) { const v = await this.get<T>(k); if (v) out.push(v); }
    return out;
  }
  async page(n: number, records: SnRecord[], pull: TablePull) {
    if (!records.length) return;
    if (pull.index) return this.put(this.key('i', pull.table, n), records);
    if (!pull.stream) return this.put(this.key('p', records[0]!.table, n), records);
    this.ctx ??= streamContext([...(await this.pages<SnRecord[]>('p')).flat(), ...(await this.pages<SnRecord[]>('i')).flat()], await this.aggregates(), this.src);
    const page: EvidencePage = { stubs: records.map(stubOf), tables: [...extractPage(records, this.ctx)] };
    await this.put(this.key('e', pull.table, n), page);
  }
  async aggregates(): Promise<Aggregate[]> { const t = await this.store.read(`${this.prefix}aggregates.json`); return t ? (JSON.parse(t) as Aggregate[]) : []; }
  async aggregate(a: Aggregate) {
    const all = (await this.aggregates()).filter((x) => x.id !== a.id);
    await this.store.write(`${this.prefix}aggregates.json`, JSON.stringify([...all, a]));
  }
  async aggregateById(id: string) { return (await this.aggregates()).find((a) => a.id === id); }
  /** For the analysis: whole context records, stubs of streamed records, and the streamed evidence. */
  async collected(): Promise<{ records: SnRecord[]; pre: PreExtracted }> {
    const ev = await this.pages<EvidencePage>('e');
    return { records: [...(await this.pages<SnRecord[]>('p')).flat(), ...ev.flatMap((p) => p.stubs)], pre: mergeExtractions(ev.map((p) => new Map(p.tables))) };
  }
  async clear() { for (const k of await this.store.list(this.prefix)) await this.store.remove(k); }
}

/** Forge refuses storage or other calls when the installation is over a limit; that passes, so back off and retry. */
export function isPlatformLimit(e: unknown): boolean {
  const m = (e as Error)?.message ?? String(e);
  return /limits for the current installation have been exceeded|rate limit|too many requests|\b429\b/i.test(m);
}
const LIMIT_RETRIES = 6;
const LIMIT_DELAY_S = 300;
const CURSOR_EVERY_MS = 15_000;

export class Workbench {
  readonly store: KvStore;

  private readonly collectBudgetMs: number;

  constructor(readonly platform: Platform, opts: { lockSeconds?: number; collectBudgetMs?: number } = {}) {
    this.store = new KvStore(platform.kv, { ...(opts.lockSeconds ? { lockSeconds: opts.lockSeconds } : {}), ...(platform.now ? { now: platform.now } : {}) });
    this.collectBudgetMs = opts.collectBudgetMs ?? COLLECT_BUDGET_MS;
  }

  private now() { return this.platform.now?.() ?? new Date(); }
  private newId() { return `${this.now().getTime().toString(36)}${Math.random().toString(36).slice(2, 10)}`; }

  // ── settings and roles ────────────────────────────────────────────────────

  async settings(): Promise<Settings> {
    return { ...DEFAULT_SETTINGS, ...((await this.platform.kv.get<Settings>('settings')) ?? {}) };
  }

  async role(caller: Caller, s?: Settings): Promise<Role> {
    if (await this.platform.isAdmin()) return 'admin';
    return (s ?? (await this.settings())).signers.includes(caller.accountId) ? 'signer' : 'none';
  }

  private async need(caller: Caller, min: 'signer' | 'admin'): Promise<{ role: Role; settings: Settings }> {
    const settings = await this.settings();
    const role = await this.role(caller, settings);
    if (role === 'none' || (min === 'admin' && role !== 'admin')) {
      throw new Error(min === 'admin' ? 'only Jira administrators can do this' : 'you do not have access to the migration workbench: ask a Jira administrator to add you as a signer');
    }
    return { role, settings };
  }

  private writeAllowed(caller: Caller, s: Settings) {
    return s.sandbox?.site === caller.siteUrl;
  }

  /** The workflow for this caller: this site only, writes only when designated, never unsigned. */
  service(caller: Caller, s: Settings, actor?: Actor): BuildService {
    const who: Actor = actor ?? (s.actAs === 'app' ? { as: 'app' } : { as: 'user', accountId: caller.accountId });
    const cfg: ServiceConfig = {
      store: this.store,
      defaultSite: caller.siteUrl,
      writeSites: this.writeAllowed(caller, s) ? [caller.siteUrl] : [],
      writeSitesHint: 'the workbench sandbox designation (Settings)',
      allowUnsigned: false,
      by: caller.accountId,
      options: { leadAccountId: caller.accountId },
      clientFor: (site, readOnly) => {
        if (site !== caller.siteUrl) throw new Error(`the workbench only works on the site it is installed on (${caller.siteUrl}), not ${site}`);
        return this.platform.client(who, readOnly);
      },
    };
    return new BuildService(cfg);
  }

  async saveSettings(caller: Caller, payload: unknown) {
    const p = parse(P.settings, payload);
    const { settings } = await this.need(caller, 'admin');
    const next: Settings = { ...settings };
    if (p.signers) next.signers = [...new Set(p.signers)];
    if (p.actAs) next.actAs = p.actAs;
    if (p.sandbox?.designate === true) {
      const phrase = designatePhrase(caller.siteUrl);
      if (p.sandbox.confirm.trim() !== phrase) throw new Error(`designation refused: type exactly "${phrase}"`);
      next.sandbox = { site: caller.siteUrl, by: caller.accountId, at: this.now().toISOString() };
    } else if (p.sandbox?.designate === false) next.sandbox = null;
    await this.platform.kv.set('settings', next);
    return this.bootstrap(caller);
  }

  async bootstrap(caller: Caller) {
    const settings = await this.settings();
    const role = await this.role(caller, settings);
    const base = { site: caller.siteUrl, accountId: caller.accountId, role, designatePhrase: designatePhrase(caller.siteUrl), partChars: CHUNK_CHARS };
    if (role === 'none') return { ...base, settings: null, writeAllowed: false, blueprints: [] };
    return { ...base, settings, writeAllowed: this.writeAllowed(caller, settings), blueprints: Object.values(await this.index()).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)) };
  }

  // ── blueprints ────────────────────────────────────────────────────────────

  private async index(): Promise<Record<string, IndexEntry>> {
    const t = await this.store.read('index/blueprints.json');
    return t ? (JSON.parse(t) as Record<string, IndexEntry>) : {};
  }

  private async indexBlueprint(bp: Blueprint, patch: Partial<IndexEntry> = {}) {
    await this.store.lock('index/blueprints.json', async () => {
      const idx = await this.index();
      const prev = idx[bp.id];
      idx[bp.id] = {
        id: bp.id, name: bp.name, customer: bp.customer.name, outcomes: bp.outcomes.length, design: bp.design.length, signedOff: isSignedOff(bp),
        uploadedBy: prev?.uploadedBy ?? '', uploadedAt: prev?.uploadedAt ?? this.now().toISOString(), chars: prev?.chars ?? 0, ...patch,
      };
      await this.store.write('index/blueprints.json', JSON.stringify(idx));
    });
  }

  private async refreshIndex(blueprintId: string) {
    const key = bpKey(blueprintId);
    const text = await this.store.read(key);
    if (text !== undefined) await this.indexBlueprint(parseBlueprint(text, key));
  }

  async uploadStart(caller: Caller, payload: unknown) {
    const p = parse(P.uploadStart, payload);
    await this.need(caller, 'admin');
    if (p.parts !== Math.ceil(p.chars / CHUNK_CHARS)) throw new Error(`invalid request: ${p.chars} characters need ${Math.ceil(p.chars / CHUNK_CHARS)} parts of ${CHUNK_CHARS}`);
    const uploadId = this.newId();
    await this.platform.kv.set(`up:${uploadId}`, { by: caller.accountId, fileName: p.fileName, chars: p.chars, parts: p.parts, at: this.now().toISOString() }, { ttlSeconds: UPLOAD_TTL });
    return { uploadId, partChars: CHUNK_CHARS };
  }

  private async upload(caller: Caller, uploadId: string) {
    const u = await this.platform.kv.get<{ by: string; fileName: string; chars: number; parts: number }>(`up:${uploadId}`);
    if (!u || u.by !== caller.accountId) throw new Error('upload not found or expired: start again');
    return u;
  }

  async uploadPart(caller: Caller, payload: unknown) {
    const p = parse(P.uploadPart, payload);
    await this.need(caller, 'admin');
    const u = await this.upload(caller, p.uploadId);
    if (p.index >= u.parts) throw new Error(`invalid request: part ${p.index} of ${u.parts}`);
    await this.platform.kv.set(`up:${p.uploadId}:${p.index}`, p.text, { ttlSeconds: UPLOAD_TTL });
    return { ok: true };
  }

  async uploadFinish(caller: Caller, payload: unknown) {
    const p = parse(P.uploadFinish, payload);
    const { settings } = await this.need(caller, 'admin');
    const u = await this.upload(caller, p.uploadId);
    const keys = Array.from({ length: u.parts }, (_, i) => `up:${p.uploadId}:${i}`);
    const got = await this.platform.kv.getMany<string>(keys);
    const missing = keys.filter((k) => !got.has(k)).length;
    if (missing) throw new Error(`upload incomplete: ${missing} of ${u.parts} parts missing`);
    const text = keys.map((k) => got.get(k)!).join('');
    if (text.length !== u.chars) throw new Error(`upload corrupt: ${text.length} characters received, ${u.chars} announced`);
    const bp = this.admit(parseBlueprint(text, u.fileName), caller);
    const key = bpKey(bp.id);
    const exists = (await this.store.read(key)) !== undefined;
    if (exists && !p.replace) throw new Error(`blueprint ${bp.id} is already in the workbench: choose replace to upload it again (its sign-off must then be renewed)`);
    await this.store.write(key, JSON.stringify(bp, null, 2));
    await this.indexBlueprint(bp, { uploadedBy: caller.accountId, uploadedAt: this.now().toISOString(), chars: text.length });
    await this.platform.kv.deleteMany([`up:${p.uploadId}`, ...keys]);
    return { blueprintId: bp.id, replaced: exists, summary: await this.service(caller, settings).summary({ blueprint: key }) };
  }

  /**
   * What an upload may bring in. Decisions dated in the future are refused (they could outlast any later change);
   * a sign-off made elsewhere is kept in the history but made stale by a recorded change, so it is renewed here.
   */
  admit(bp: Blueprint, caller: Caller): Blueprint {
    const now = this.now();
    const limit = new Date(now.getTime() + 5 * 60_000).toISOString();
    const future = bp.decisions.filter((d) => !(Date.parse(d.at) > 0) || d.at > limit);
    if (future.length) throw new Error(`upload refused: ${future.length} decision(s) have an invalid or future date (${future[0]!.id})`);
    if (!bp.decisions.some((d) => d.action === 'sign-off')) return bp;
    // The change must sort after every uploaded decision (some may be a few minutes ahead through clock skew).
    const latest = Math.max(now.getTime(), ...bp.decisions.map((d) => Date.parse(d.at) + 1));
    const at = new Date(latest).toISOString();
    return {
      ...bp,
      decisions: [...bp.decisions, {
        id: `d.workbench-upload.${at.replace(/\D/g, '')}`, at, by: caller.accountId, subject: { kind: 'blueprint', id: bp.id }, action: 'change',
        comment: 'Uploaded to the Forge workbench: a sign-off recorded elsewhere is not trusted here and must be renewed in the workbench.',
      }],
    } as Blueprint;
  }

  async summary(caller: Caller, payload: unknown) {
    const p = parse(P.blueprint, payload);
    const { settings } = await this.need(caller, 'signer');
    const svc = this.service(caller, settings);
    const [summary, status] = await Promise.all([svc.summary({ blueprint: bpKey(p.blueprintId) }), svc.status({ blueprint: bpKey(p.blueprintId) })]);
    return { summary, status, jobs: await this.jobs(p.blueprintId) };
  }

  private async readBlueprint(blueprintId: string): Promise<Blueprint> {
    const key = bpKey(blueprintId);
    const text = await this.store.read(key);
    if (text === undefined) throw new Error(`no blueprint ${blueprintId} in the workbench`);
    return parseBlueprint(text, key);
  }

  /** What the analysis found in ServiceNow, by component category. */
  async inventory(caller: Caller, payload: unknown) {
    const p = parse(P.blueprint, payload);
    await this.need(caller, 'signer');
    return snInventory(await this.readBlueprint(p.blueprintId));
  }

  async inventoryItems(caller: Caller, payload: unknown) {
    const p = parse(P.inventoryItems, payload);
    await this.need(caller, 'signer');
    return snItems(await this.readBlueprint(p.blueprintId), p);
  }

  /** What JSM needs: every design element by category, how it gets built, and the fit gaps. Blueprint only. */
  async jsmGaps(caller: Caller, payload: unknown) {
    const p = parse(P.blueprint, payload);
    await this.need(caller, 'signer');
    return jsmGaps(await this.readBlueprint(p.blueprintId));
  }

  async setSpace(caller: Caller, payload: unknown) {
    const { blueprintId, ...rest } = parse(P.setSpace, payload);
    const { settings } = await this.need(caller, 'admin');
    const r = await this.service(caller, settings).setSpace({ blueprint: bpKey(blueprintId), ...rest } as Parameters<BuildService['setSpace']>[0]);
    await this.refreshIndex(blueprintId);
    return r;
  }

  async signOffReview(caller: Caller, payload: unknown) {
    const p = parse(P.blueprint, payload);
    const { settings } = await this.need(caller, 'signer');
    return this.service(caller, settings).signOffReview({ blueprint: bpKey(p.blueprintId) });
  }

  async signOff(caller: Caller, payload: unknown) {
    const { blueprintId, ...rest } = parse(P.signOff, payload);
    const { settings } = await this.need(caller, 'signer');
    const r = await this.service(caller, settings).signOff({ blueprint: bpKey(blueprintId), ...rest } as Parameters<BuildService['signOff']>[0]);
    await this.refreshIndex(blueprintId);
    return r;
  }

  // ── jobs: dry-run, verify, apply ──────────────────────────────────────────

  async startJob(caller: Caller, payload: unknown) {
    const p = parse(P.startJob, payload);
    const { settings } = await this.need(caller, 'admin');
    const svc = this.service(caller, settings);
    const blueprint = bpKey(p.blueprintId);
    await svc.loadBlueprint(blueprint);
    if (p.op === 'apply') {
      if (!p.planHash || !p.confirm) throw new Error('apply needs the reviewed planHash and the typed confirmation');
      await svc.checkApply({ blueprint, planHash: p.planHash, confirm: p.confirm }); // refuse now, not later in the queue
    }
    const active = await this.activeJob(p.blueprintId);
    if (active) throw new Error(`a ${active.op} is already ${active.status} for this blueprint (job ${active.id}); wait for it to finish`);
    const job: Job = {
      id: this.newId(), op: p.op, blueprintId: p.blueprintId, by: caller.accountId, status: 'queued', queuedAt: this.now().toISOString(),
      ...(p.planHash ? { planHash: p.planHash } : {}), ...(p.confirm ? { confirm: p.confirm } : {}),
      ...(p.capabilityIds || p.elementIds ? { scope: { ...(p.capabilityIds ? { capabilityIds: p.capabilityIds } : {}), ...(p.elementIds ? { elementIds: p.elementIds } : {}) } } : {}),
    };
    await this.saveJob(job);
    await this.pruneJobs(p.blueprintId);
    try {
      await this.platform.enqueue({ jobId: job.id, blueprintId: job.blueprintId }, `bp-${safeName(p.blueprintId)}`.slice(0, 60));
    } catch (e) {
      await this.saveJob({ ...job, status: 'failed', finishedAt: this.now().toISOString(), error: `could not queue: ${(e as Error).message}` });
      throw e;
    }
    return job;
  }

  /**
   * The job still queued or running for a blueprint, if any. One older than the consumer's time limit was cut off by
   * the platform (no result was recorded): mark it failed so it no longer blocks; the state lock has expired by then.
   */
  private async activeJob(blueprintId: string): Promise<Job | undefined> {
    for (const j of await this.jobs(blueprintId)) {
      if (j.status !== 'queued' && j.status !== 'running') continue;
      const since = Date.parse(j.heartbeatAt ?? j.startedAt ?? j.queuedAt);
      if (this.now().getTime() - since < JOB_STALE_MS) return j;
      const full = await this.loadJob(blueprintId, j.id);
      if (full && (full.status === 'queued' || full.status === 'running')) {
        const { confirm: _c, ...rest } = full;
        await this.saveJob({ ...rest, status: 'failed', finishedAt: this.now().toISOString(), error: full.op === 'collect'
          ? 'interrupted: no progress within the time limit; resume it from its last checkpoint'
          : 'interrupted: no result after the time limit; check the state, then start it again' } as Job);
      }
    }
    return undefined;
  }

  private async saveJob(j: Job) { await this.store.write(`${jobsPrefix(j.blueprintId)}${j.id}.json`, JSON.stringify(j)); }

  private async loadJob(blueprintId: string, jobId: string): Promise<Job | undefined> {
    const t = await this.store.read(`${jobsPrefix(blueprintId)}${jobId}.json`);
    return t ? (JSON.parse(t) as Job) : undefined;
  }

  async jobs(blueprintId: string): Promise<Job[]> {
    const keys = await this.store.list(jobsPrefix(blueprintId));
    const jobs = await Promise.all(keys.map(async (k) => JSON.parse((await this.store.read(k)) ?? 'null') as Job | null));
    return jobs.filter((j): j is Job => Boolean(j)).sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)).map(({ confirm: _c, result: _r, ...j }) => j as Job);
  }

  private async pruneJobs(blueprintId: string) {
    const all = await this.jobs(blueprintId);
    for (const j of all.slice(KEEP_JOBS)) if (j.status === 'done' || j.status === 'failed') await this.store.remove(`${jobsPrefix(blueprintId)}${j.id}.json`);
  }

  async job(caller: Caller, payload: unknown) {
    const p = parse(P.job, payload);
    await this.need(caller, 'signer');
    const j = await this.loadJob(p.blueprintId, p.jobId);
    if (!j) throw new Error(`job ${p.jobId} not found`);
    const { confirm: _c, ...rest } = j;
    return rest;
  }

  /**
   * Run a queued job (the queue consumer). Never throws: a failure is recorded on the job, so the platform does not
   * retry it, and a job that already started is never run again.
   */
  async runJob(msg: JobMessage, caller: Omit<Caller, 'accountId'>, retry = false): Promise<Job | undefined> {
    const job = typeof msg.blueprintId === 'string' && typeof msg.jobId === 'string' ? await this.loadJob(msg.blueprintId, msg.jobId) : undefined;
    if (!job) return job;
    const settings = await this.settings();
    const me: Caller = { ...caller, accountId: job.by };
    if (job.op === 'collect') {
      // Read-only and resumable from its checkpoint, so a retried or continued step is safe; stale messages are not.
      const step = typeof msg.step === 'number' ? msg.step : 0;
      const expected = job.status === 'queued' ? 0 : job.status === 'running' ? job.step : undefined;
      if (expected !== step) return job;
      return this.runCollect(job, step, me);
    }
    if (job.status !== 'queued') return job;
    const started: Job = { ...job, status: 'running', startedAt: this.now().toISOString() };
    if (retry) {
      const failed: Job = { ...started, status: 'failed', finishedAt: this.now().toISOString(), error: 'the job was interrupted and is not re-run automatically; check the state and start it again' };
      await this.saveJob(failed);
      return failed;
    }
    await this.saveJob(started);
    const svc = this.service(me, settings);
    const blueprint = bpKey(job.blueprintId);
    const scopeIn = job.scope ?? {};
    let done: Job;
    try {
      const result = job.op === 'dry-run'
        ? await svc.plan({ blueprint, dryRun: true, ...scopeIn })
        : job.op === 'verify'
          ? await svc.verify({ blueprint, ...scopeIn })
          : await svc.apply({ blueprint, planHash: job.planHash ?? '', confirm: job.confirm ?? '', ...scopeIn });
      done = { ...started, status: 'done', finishedAt: this.now().toISOString(), result };
    } catch (e) {
      done = { ...started, status: 'failed', finishedAt: this.now().toISOString(), error: (e as Error).message ?? String(e) };
    }
    const { confirm: _c, ...finished } = done;
    await this.saveJob(finished as Job);
    return finished as Job;
  }

  // ── ServiceNow connection: collect and analyse instead of uploading ──────

  private profileOf(payload: unknown): Profile {
    return parse(P.profile, payload ?? {}).profile ?? 'oauth';
  }

  private async connectionRecord(profile: Profile): Promise<Connection | undefined> {
    return this.platform.kv.get<Connection>(PROFILES[profile].conn);
  }

  private snLog(profile: Profile) {
    return new SnLog(this.store, PROFILES[profile].log, () => this.now().getTime());
  }

  /** The connection as admins see it: never the client secret or password, only whether they are stored. */
  async connection(caller: Caller, payload?: unknown) {
    const profile = this.profileOf(payload);
    await this.need(caller, 'admin');
    const c = await this.connectionRecord(profile);
    const secret = c ? await this.platform.kv.getSecret<ConnectionSecret>(PROFILES[profile].secret) : undefined;
    return {
      profile,
      connection: c ?? null,
      hasClientSecret: Boolean(secret?.clientSecret),
      hasPassword: Boolean(secret?.password),
      nextBlueprintId: c ? blueprintIdFor(c.customer, this.now().toISOString()) : null,
      jobs: (await this.collectJobs()).filter((j) => (j.collect?.profile ?? 'oauth') === profile),
    };
  }

  /** Collections with their (small) results, after marking ones that stopped making progress as failed. */
  private async collectJobs(): Promise<Job[]> {
    await this.activeJob(COLLECT);
    const all = await Promise.all((await this.jobs(COLLECT)).map((j) => this.loadJob(COLLECT, j.id)));
    return all.filter((j): j is Job => Boolean(j));
  }

  async saveConnection(caller: Caller, payload: unknown) {
    if ((payload as { profile?: unknown } | null)?.profile === 'basic') return this.saveBasicConnection(caller, payload);
    const p = parse(P.connection, payload);
    await this.need(caller, 'admin');
    const keys = PROFILES.oauth;
    const instance = normaliseInstanceUrl(p.instance);
    const prev = await this.connectionRecord('oauth');
    const prevSecret = prev ? await this.platform.kv.getSecret<ConnectionSecret>(keys.secret) : undefined;
    // A stored secret is only reused for the same instance, client and user; otherwise it must be entered again.
    const same = prev && prev.instance === instance && prev.clientId === p.clientId && (p.grant !== 'password' || prev.username === p.username);
    const clientSecret = p.clientSecret || (same ? prevSecret?.clientSecret : undefined);
    if (!clientSecret) throw new Error('enter the client secret from the ServiceNow application registry');
    let password: string | undefined;
    if (p.grant === 'password') {
      if (!p.username) throw new Error('the password grant needs the integration user name');
      password = p.password || (same ? prevSecret?.password : undefined);
      if (!password) throw new Error("enter the integration user's password");
    }
    const c: Connection = {
      instance, grant: p.grant, clientId: p.clientId, ...(p.grant === 'password' ? { username: p.username! } : {}),
      ...(p.scope?.trim() ? { scope: p.scope.trim() } : {}),
      customer: p.customer?.trim() || new URL(instance).hostname.split('.')[0]!, usageDays: p.usageDays ?? 365, requestsPerSecond: p.requestsPerSecond ?? 4,
      updatedBy: caller.accountId, updatedAt: this.now().toISOString(),
    };
    await this.platform.kv.setSecret(keys.secret, { clientSecret, ...(password ? { password } : {}) } satisfies ConnectionSecret);
    await this.platform.kv.set(keys.conn, c);
    return this.connection(caller, { profile: 'oauth' });
  }

  /** Basic auth (demo) connection: a ServiceNow user name and password, nothing else. */
  private async saveBasicConnection(caller: Caller, payload: unknown) {
    const p = parse(P.basicConnection, payload);
    await this.need(caller, 'admin');
    const keys = PROFILES.basic;
    const instance = normaliseInstanceUrl(p.instance);
    const username = p.username.trim();
    const prev = await this.connectionRecord('basic');
    const prevSecret = prev ? await this.platform.kv.getSecret<ConnectionSecret>(keys.secret) : undefined;
    const same = prev && prev.instance === instance && prev.username === username;
    const password = p.password || (same ? prevSecret?.password : undefined);
    if (!password) throw new Error("enter the ServiceNow user's password");
    const c: Connection = {
      instance, grant: 'basic', clientId: '', username,
      customer: p.customer?.trim() || new URL(instance).hostname.split('.')[0]!, usageDays: p.usageDays ?? 365, requestsPerSecond: p.requestsPerSecond ?? 4,
      updatedBy: caller.accountId, updatedAt: this.now().toISOString(),
    };
    await this.platform.kv.setSecret(keys.secret, { password } satisfies ConnectionSecret);
    await this.platform.kv.set(keys.conn, c);
    const log = this.snLog('basic');
    log.event(`connection saved for ${instance} as ${username}`);
    await log.flush();
    return this.connection(caller, { profile: 'basic' });
  }

  async removeConnection(caller: Caller, payload?: unknown) {
    const profile = this.profileOf(payload);
    await this.need(caller, 'admin');
    await this.platform.kv.deleteSecret(PROFILES[profile].secret);
    await this.platform.kv.delete(PROFILES[profile].conn);
    return this.connection(caller, { profile });
  }

  /** Recent ServiceNow requests and events for a connection, newest first. Never credentials or tokens. */
  async snLogs(caller: Caller, payload?: unknown) {
    const profile = this.profileOf(payload);
    await this.need(caller, 'admin');
    const entries = JSON.parse((await this.store.read(PROFILES[profile].log)) ?? '[]') as LogEntry[];
    return { profile, entries: entries.reverse() };
  }

  async clearSnLogs(caller: Caller, payload?: unknown) {
    const profile = this.profileOf(payload);
    await this.need(caller, 'admin');
    await this.store.write(PROFILES[profile].log, '[]');
    return { profile, entries: [] as LogEntry[] };
  }

  private async snClient(c: Connection, profile: Profile, log?: SnLog): Promise<{ client: ServiceNowClient; auth: TokenProvider }> {
    const secret = await this.platform.kv.getSecret<ConnectionSecret>(PROFILES[profile].secret);
    const http = log ? loggingFetch(this.platform.snFetch, log.http, () => this.now().getTime()) : this.platform.snFetch;
    let auth: TokenProvider;
    if (c.grant === 'basic') {
      if (!secret?.password) throw new Error('the demo connection has no stored password: save it again');
      auth = new BasicAuthProvider(c.username ?? '', secret.password);
    } else {
      if (!secret?.clientSecret) throw new Error('the ServiceNow connection has no stored secret: save the connection again');
      auth = c.grant === 'password'
        ? new PasswordGrantProvider(c.instance, { clientId: c.clientId, clientSecret: secret.clientSecret, username: c.username ?? '', password: secret.password ?? '', ...(c.scope ? { scope: c.scope } : {}) }, http)
        : new ClientCredentialsProvider(c.instance, c.clientId, secret.clientSecret, http, Date.now, c.scope);
    }
    return { auth, client: new ServiceNowClient({ instanceUrl: c.instance, auth, fetch: http, maxRequestsPerSecond: c.requestsPerSecond, pageSize: 500, ...(this.platform.sleep ? { sleep: this.platform.sleep } : {}) }) };
  }

  /** Sign-in, instance version, a table read and a count: each reported separately, so a missing grant is obvious. */
  async testConnection(caller: Caller, payload?: unknown) {
    const profile = this.profileOf(payload);
    await this.need(caller, 'admin');
    const c = await this.connectionRecord(profile);
    if (!c) throw new Error('save a ServiceNow connection first');
    const log = this.snLog(profile);
    log.event(`test started: ${c.instance}, ${c.grant === 'basic' ? `basic auth as ${c.username}` : `OAuth ${c.grant}`}`);
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const check = async (name: string, fn: () => Promise<string>) => {
      try { checks.push({ name, ok: true, detail: await fn() }); log.event(`✓ ${name}: ${checks.at(-1)!.detail}`); return true; } catch (e) {
        checks.push({ name, ok: false, detail: (e as Error).message }); log.event(`✗ ${name}: ${(e as Error).message}`, 'error'); return false;
      }
    };
    try {
      const { client, auth } = await this.snClient(c, profile, log);
      let release: string | undefined;
      const signIn = c.grant === 'basic'
        // Any answer but 401 means the credentials were accepted; 403 only means no read on that table.
        ? check('Sign in (basic auth)', async () => {
          try { await client.get('/api/now/table/sys_properties?sysparm_query=name%3Dglide.buildname&sysparm_fields=name&sysparm_limit=1'); } catch (e) {
            if (!(e instanceof ServiceNowError) || e.status !== 403) throw e;
          }
          return `signed in as ${c.username}`;
        })
        : check('OAuth token', async () => { await auth.getToken(true); return 'issued'; });
      if (await signIn) {
        await check('Instance version (sys_properties)', async () => { release = (await client.instanceInfo()).build; return release ?? 'unknown (no read on sys_properties)'; });
        await check('Catalog items (Table API)', async () => { for await (const p of client.iterateTable('sc_cat_item', { fields: ['name'], limit: 1 })) return `readable (${p.records.length} sampled)`; return 'readable (empty)'; });
        await check('Counts (Aggregate API)', async () => `${await client.count('sys_user_group')} groups`);
      }
      const ok = checks.every((x) => x.ok);
      log.event(`test ${ok ? 'passed' : 'failed'}`, ok ? 'info' : 'error');
      await this.platform.kv.set(PROFILES[profile].conn, { ...c, lastTest: { ok, at: this.now().toISOString(), ...(release ? { release } : {}), checks } } satisfies Connection);
      return { ok, release: release ?? null, checks };
    } catch (e) {
      log.event(`test could not run: ${(e as Error).message}`, 'error');
      throw e;
    } finally {
      await log.flush();
    }
  }

  /** Start collecting from ServiceNow; the analysis at the end becomes a blueprint (not signed off). */
  async startCollection(caller: Caller, payload: unknown) {
    const p = parse(P.collect, payload);
    const profile = p.profile ?? 'oauth';
    await this.need(caller, 'admin');
    const c = await this.connectionRecord(profile);
    if (!c) throw new Error('save a ServiceNow connection first');
    const target = blueprintIdFor(c.customer, this.now().toISOString());
    if (!p.replace && (await this.store.read(bpKey(target))) !== undefined) {
      throw new Error(`blueprint ${target} is already in the workbench: choose replace to collect it again (its sign-off must then be renewed)`);
    }
    const active = await this.activeJob(COLLECT);
    if (active) throw new Error(`a collection is already ${active.status} (job ${active.id}); wait for it to finish`);
    const job: Job = {
      id: this.newId(), op: 'collect', blueprintId: COLLECT, by: caller.accountId, status: 'queued', queuedAt: this.now().toISOString(),
      collect: { customer: c.customer, instance: c.instance, replace: Boolean(p.replace), profile },
    };
    // A new collection supersedes earlier ones: drop their stored pages (they count against app storage).
    const leftovers = (await this.store.list('collections/')).filter((k) => !k.startsWith(`collections/${job.id}/`));
    for (const k of leftovers) await this.store.remove(k);
    await this.saveJob(job);
    await this.pruneJobs(COLLECT);
    const log = this.snLog(profile);
    if (leftovers.length) log.event(`removed ${leftovers.length} stored items of earlier collections (they can no longer be resumed)`);
    log.event(`collection ${job.id} queued for ${c.instance}`);
    await log.flush();
    await this.enqueueCollect(job, 0);
    return job;
  }

  /** Continue a collection that failed or was cut off, from its last checkpoint. */
  async resumeCollection(caller: Caller, payload: unknown) {
    const p = parse(P.resume, payload);
    await this.need(caller, 'admin');
    const job = await this.loadJob(COLLECT, p.jobId);
    if (!job || job.op !== 'collect') throw new Error(`collection ${p.jobId} not found`);
    if (job.status !== 'failed') throw new Error(`collection ${p.jobId} is ${job.status}; only a failed collection can be resumed`);
    const saved = await this.store.read(`collections/${job.id}/cursor.json`);
    if (saved === undefined) throw new Error('nothing to resume from: start a new collection');
    if (((JSON.parse(saved) as CollectCursor).version ?? 1) !== CURSOR_VERSION) throw new Error('this collection was started by an earlier version of the app and cannot be resumed; start a new collection');
    const active = await this.activeJob(COLLECT);
    if (active) throw new Error(`a collection is already ${active.status} (job ${active.id})`);
    const step = (job.step ?? 0) + 1;
    const { error: _e, finishedAt: _f, ...rest } = job;
    const resumed: Job = { ...rest, status: 'running', step, heartbeatAt: this.now().toISOString() };
    await this.saveJob(resumed);
    const log = this.snLog(job.collect?.profile ?? 'oauth');
    log.event(`collection ${job.id} resumed from its last checkpoint`);
    await log.flush();
    await this.enqueueCollect(resumed, step);
    return resumed;
  }

  private async enqueueCollect(job: Job, step: number) {
    try {
      await this.platform.enqueue({ jobId: job.id, blueprintId: COLLECT, step }, `bp-${COLLECT}`);
    } catch (e) {
      await this.saveJob({ ...job, status: 'failed', finishedAt: this.now().toISOString(), error: `could not queue: ${(e as Error).message}` });
      throw e;
    }
  }

  /** One invocation of a collection: work until the budget is used, checkpoint, and queue the next step. */
  private async runCollect(job: Job, step: number, me: Caller): Promise<Job> {
    const started = this.now().getTime();
    const prefix = `collections/${job.id}/`;
    const profile = job.collect?.profile ?? 'oauth';
    const log = this.snLog(profile);
    let running: Job = { ...job, status: 'running', step, heartbeatAt: new Date(started).toISOString(), ...(job.startedAt ? {} : { startedAt: new Date(started).toISOString() }) };
    await this.saveJob(running);
    const fail = async (message: string) => {
      log.event(`collection ${job.id} failed: ${message}`, 'error');
      const failed: Job = { ...running, status: 'failed', finishedAt: this.now().toISOString(), error: message };
      await this.saveJob(failed);
      return failed;
    };
    try {
      const c = await this.connectionRecord(profile);
      if (!c || c.instance !== job.collect?.instance) return await fail('the ServiceNow connection changed or was removed during the collection; start a new one');
      const { client } = await this.snClient(c, profile, log);
      const sink = new StoreSink(this.store, prefix, { instance: c.instance, capturedAt: running.startedAt!, usageDays: c.usageDays });
      const saved = await this.store.read(`${prefix}cursor.json`);
      const from: CollectCursor = saved ? (JSON.parse(saved) as CollectCursor) : startCursor();
      log.event(`collection ${job.id} step ${step + 1}: ${from.phase} ${from.index}${from.startAfter ? ' (mid-table)' : ''}`);
      const totals = { info: 1, pulls: STANDARD_PULLS.length, aggregates: standardAggregates(c.usageDays).length, done: 0 };
      const progress = (x: CollectCursor): Progress => ({
        phase: x.phase, index: x.index, total: x.phase === 'fill' ? (x.fill?.length ?? 0) : totals[x.phase], pages: x.pages, warnings: x.warnings.length,
      });
      let moved = false;
      let cursorSavedAt = 0;
      let warned = from.warnings.length;
      const cursor = await collectSteps(client, from, sink, {
        usageDays: c.usageDays,
        // Every step reaches at least one checkpoint before it may stop, so a chain of steps always moves forward.
        shouldStop: () => moved && this.now().getTime() - started >= this.collectBudgetMs,
        checkpoint: async (x) => {
          // The cursor is saved at most every 15 s: on resume, pages after it are fetched and overwritten again.
          moved = true;
          if (this.now().getTime() - cursorSavedAt >= CURSOR_EVERY_MS) { await this.store.write(`${prefix}cursor.json`, JSON.stringify(x)); cursorSavedAt = this.now().getTime(); }
          for (const w of x.warnings.slice(warned)) log.event(`warning: ${w}`);
          warned = x.warnings.length;
          await log.flush(false);
        },
      });
      await this.store.write(`${prefix}cursor.json`, JSON.stringify(cursor));
      if (cursor.phase !== 'done') {
        const { limitRetries: _r, waitingUntil: _w, ...rest } = running;
        running = { ...rest, step: step + 1, heartbeatAt: this.now().toISOString(), progress: progress(cursor) };
        await this.saveJob(running);
        log.event(`collection ${job.id} paused at ${cursor.phase} ${cursor.index} after ${cursor.pages} pages; next step queued`);
        try {
          await this.platform.enqueue({ jobId: job.id, blueprintId: COLLECT, step: step + 1 }, `bp-${COLLECT}`);
        } catch (e) {
          return await fail(`paused at a checkpoint but could not queue the next step (${(e as Error).message}); resume it`);
        }
        return running;
      }

      // Done: analyse, admit (never signed off), store as a blueprint, and drop the collected pages.
      const { records, pre } = await sink.collected();
      const snapshot = snapshotOf(c.instance, cursor, records, await sink.aggregates(), c.usageDays, running.startedAt!);
      const bp = this.admit(analyse(snapshot, { customer: job.collect.customer, now: this.now().toISOString() }, pre).blueprint, me);
      const key = bpKey(bp.id);
      const exists = (await this.store.read(key)) !== undefined;
      if (exists && !job.collect.replace) return await fail(`blueprint ${bp.id} appeared in the workbench during the collection; resume after choosing replace, or start again with replace`);
      const text = JSON.stringify(bp, null, 2);
      await this.store.write(key, text);
      await this.indexBlueprint(bp, { uploadedBy: job.by, uploadedAt: this.now().toISOString(), chars: text.length, source: `ServiceNow ${c.instance.replace(/^https:\/\//, '')}` });
      await sink.clear();
      const done: Job = {
        ...running, status: 'done', finishedAt: this.now().toISOString(), progress: { ...progress(cursor), records: records.length },
        result: { blueprintId: bp.id, replaced: exists, release: cursor.release ?? null, records: records.length, aggregates: snapshot.aggregates.length, warnings: cursor.warnings.slice(0, 50), warningCount: cursor.warnings.length, outcomes: bp.outcomes.length, design: bp.design.length },
      };
      await this.saveJob(done);
      log.event(`collection ${job.id} done: blueprint ${bp.id} from ${records.length} records, ${cursor.warnings.length} warnings`);
      return done;
    } catch (e) {
      if (isPlatformLimit(e) && (running.limitRetries ?? 0) < LIMIT_RETRIES) {
        // Wait the limit out: queue the same step again later; it continues from the last saved cursor.
        const retries = (running.limitRetries ?? 0) + 1;
        const until = new Date(this.now().getTime() + LIMIT_DELAY_S * 1000).toISOString();
        log.event(`Forge limit reached for this installation (${(e as Error).message}); waiting ${LIMIT_DELAY_S / 60} min, retry ${retries} of ${LIMIT_RETRIES}`, 'error');
        try {
          await this.platform.enqueue({ jobId: job.id, blueprintId: COLLECT, step }, `bp-${COLLECT}`, LIMIT_DELAY_S);
          running = { ...running, limitRetries: retries, waitingUntil: until, heartbeatAt: until };
          await this.saveJob(running).catch(() => undefined);
          return running;
        } catch { /* could not even queue: fall through and fail, so it can be resumed by hand */ }
      }
      return await fail(isPlatformLimit(e)
        ? `Forge limits for this installation were exceeded (${(e as Error).message}); wait a few minutes, then resume from the last checkpoint`
        : `${(e as Error).message ?? String(e)} (the collection can be resumed from its last checkpoint)`);
    } finally {
      await log.flush();
    }
  }

  // ── guided steps, status, reports, acceptance plan ────────────────────────

  async manualSteps(caller: Caller, payload: unknown) {
    const p = parse(P.blueprint, payload);
    const { settings } = await this.need(caller, 'signer');
    return this.service(caller, settings).manualSteps({ blueprint: bpKey(p.blueprintId) });
  }

  async confirmManual(caller: Caller, payload: unknown) {
    const { blueprintId, ...rest } = parse(P.confirmManual, payload);
    const { settings } = await this.need(caller, 'admin');
    return this.service(caller, settings).confirmManual({ blueprint: bpKey(blueprintId), ...rest } as Parameters<BuildService['confirmManual']>[0]);
  }

  async report(caller: Caller, payload: unknown) {
    const p = parse(P.report, payload);
    const { settings } = await this.need(caller, 'signer');
    return { key: p.key, markdown: await this.service(caller, settings).readReport(p.key) };
  }

  async acceptancePlan(caller: Caller, payload: unknown) {
    const { blueprintId, outcomeIds } = parse(P.acceptancePlan, payload);
    const { settings } = await this.need(caller, 'signer');
    const r = await this.service(caller, settings).acceptancePlan({ blueprint: bpKey(blueprintId), ...(outcomeIds?.length ? { outcomeIds } : {}) });
    // Acceptance runs act as test personas with their own credentials, so they stay in the CLI / MCP server for now.
    return { ...r, phrase: null, run: 'Acceptance runs need test-persona credentials and run from the CLI or Rovo (acceptance_run).' };
  }
}
