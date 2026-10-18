import { z } from 'zod';
import type { Blueprint } from '@snjsm/model';
import { isSignedOff, type SiteApi } from '@snjsm/builder';
import { BuildService, parseBlueprint, safeName, hostOf, type ServiceConfig } from '@snjsm/workflow';
import { CHUNK_CHARS, KvStore, type Kv } from './kv-store';

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
export type JobOp = 'dry-run' | 'verify' | 'apply';

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
  /** A client for this site acting as actor. */
  client(actor: Actor, readOnly: boolean): SiteApi;
  /** Whether the calling user is a Jira administrator (checked as that user). */
  isAdmin(): Promise<boolean>;
  /** Queue a job; jobs with the same concurrency key run one at a time. */
  enqueue(msg: JobMessage, concurrencyKey: string): Promise<void>;
  now?(): Date;
}

export interface JobMessage { jobId: string; blueprintId: string; [k: string]: unknown }

export interface Job {
  id: string; op: JobOp; blueprintId: string; by: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  queuedAt: string; startedAt?: string; finishedAt?: string;
  planHash?: string; confirm?: string;
  scope?: { capabilityIds?: string[]; elementIds?: string[] };
  result?: unknown; error?: string;
}

export const designatePhrase = (site: string) => `DESIGNATE ${hostOf(site)} AS SANDBOX`;

const MAX_UPLOAD_CHARS = 20_000_000;
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

interface IndexEntry { id: string; name: string; customer: string; uploadedBy: string; uploadedAt: string; chars: number; outcomes: number; design: number; signedOff: boolean }

export class Workbench {
  readonly store: KvStore;

  constructor(readonly platform: Platform, opts: { lockSeconds?: number } = {}) {
    this.store = new KvStore(platform.kv, { ...opts, ...(platform.now ? { now: platform.now } : {}) });
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
      const since = Date.parse(j.startedAt ?? j.queuedAt);
      if (this.now().getTime() - since < JOB_STALE_MS) return j;
      const full = await this.loadJob(blueprintId, j.id);
      if (full && (full.status === 'queued' || full.status === 'running')) {
        const { confirm: _c, ...rest } = full;
        await this.saveJob({ ...rest, status: 'failed', finishedAt: this.now().toISOString(), error: 'interrupted: no result after the time limit; check the state, then start it again' } as Job);
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
    if (!job || job.status !== 'queued') return job;
    const settings = await this.settings();
    const me: Caller = { ...caller, accountId: job.by };
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
