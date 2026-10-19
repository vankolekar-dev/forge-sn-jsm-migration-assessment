import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeServiceNow, snapshotFromXml, type HttpFetch } from '@snjsm/collector';
import { analyse } from '@snjsm/analyser';
import { UnreachableError } from '@snjsm/atlassian';
import { FakeSite, isSignedOff, type SiteApi } from '@snjsm/builder';
import type { Blueprint } from '@snjsm/model';
import { confirmPhrase, parseBlueprint, signOffPhrase } from '@snjsm/workflow';
import { CHUNK_CHARS, MemoryKv } from '../src/kv-store';
import { COLLECT, designatePhrase, Workbench, type Actor, type Caller, type Job, type JobMessage } from '../src/workbench';

const xml = readFileSync(join(__dirname, '../../../packages/collector/test/fixtures/enterprise-update-set.xml'), 'utf8');
const snap = snapshotFromXml([{ name: 'enterprise.xml', xml }]);
const base = analyse(snap, { customer: 'Fixture Co', now: '2026-01-01T00:00:00Z' }).blueprint;
const signedElsewhere = (bp: Blueprint, at = '2026-01-02T00:00:00Z'): Blueprint => ({ ...bp, decisions: [...bp.decisions, { id: 'd.sign-off.cli', at, by: 'someone', subject: { kind: 'blueprint', id: bp.id }, action: 'sign-off' }] });

/** A FakeSite seen through Forge: api.atlassian.com product APIs (Automation) are unreachable. */
function forgeView(c: SiteApi): SiteApi {
  return { ...c, call: async (m: string, url: string) => { throw new UnreachableError(m, url.replace(/^https:\/\/[^/]+/, ''), 'test'); } } as SiteApi;
}

function setup(opts: { collectBudgetMs?: number; fakeClock?: boolean } = {}) {
  const site = new FakeSite();
  const kv = new MemoryKv();
  // ServiceNow: a fake instance; every request moves the clock on a second, so collection budgets run out.
  const sn = new FakeServiceNow(snap.records);
  const clock = { t: Date.parse('2026-03-01T00:00:00Z'), down: false };
  const snFetch: HttpFetch = async (url, init) => {
    clock.t += 1000;
    if (clock.down) throw new TypeError('fetch failed');
    return sn.fetch(url, init);
  };
  const queue: { msg: JobMessage; key: string; delay?: number }[] = [];
  const actors: Actor[] = [];
  const who = { admin: true };
  const wb = new Workbench({
    kv,
    client: (actor, ro) => { actors.push(actor); return forgeView(site.client(ro)); },
    isAdmin: async () => who.admin,
    enqueue: async (msg, key, delay) => { queue.push({ msg, key, ...(delay ? { delay } : {}) }); },
    snFetch,
    sleep: async () => {},
    ...(opts.fakeClock ? { now: () => new Date(clock.t) } : {}),
  }, opts);
  const admin: Caller = { accountId: 'acc-admin', siteUrl: site.siteUrl, cloudId: '11111111-2222-3333-4444-555555555555' };
  const signer: Caller = { ...admin, accountId: 'acc-signer' };
  const outsider: Caller = { ...admin, accountId: 'acc-outsider' };
  const as = (c: Caller) => { who.admin = c === admin; return c; };
  /** Upload in parts, the way the UI does. */
  const upload = async (c: Caller, bp: unknown, replace?: boolean) => {
    const text = JSON.stringify(bp);
    const parts = Math.ceil(text.length / CHUNK_CHARS);
    const { uploadId } = await wb.uploadStart(as(c), { fileName: 'blueprint.json', chars: text.length, parts });
    for (let i = 0; i < parts; i++) await wb.uploadPart(as(c), { uploadId, index: i, text: text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) });
    return wb.uploadFinish(as(c), { uploadId, ...(replace ? { replace } : {}) });
  };
  /** Run the next queued job, as the consumer would. */
  const drain = async (retry = false) => {
    const q = queue.shift();
    if (!q) throw new Error('nothing queued');
    return (await wb.runJob(q.msg, { siteUrl: site.siteUrl, cloudId: admin.cloudId }, retry))!;
  };
  return { site, kv, sn, clock, wb, queue, actors, admin, signer, outsider, as, upload, drain };
}

describe('workbench', () => {
  it('checks roles on the server: outsiders see nothing, signers read and sign off, admins build', async () => {
    const t = setup();
    const out = await t.wb.bootstrap(t.as(t.outsider));
    expect(out).toMatchObject({ role: 'none', settings: null, blueprints: [] });
    await expect(t.upload(t.outsider, base)).rejects.toThrow(/only Jira administrators/);
    await t.upload(t.admin, base);
    await expect(t.wb.summary(t.as(t.outsider), { blueprintId: base.id })).rejects.toThrow(/do not have access/);
    await expect(t.wb.saveSettings(t.as(t.signer), { signers: ['acc-signer'] })).rejects.toThrow(/only Jira administrators/);
    await t.wb.saveSettings(t.as(t.admin), { signers: ['acc-signer'] });
    expect((await t.wb.bootstrap(t.as(t.signer))).role).toBe('signer');
    expect((await t.wb.summary(t.as(t.signer), { blueprintId: base.id })).summary.id).toBe(base.id);
    await expect(t.wb.startJob(t.as(t.signer), { blueprintId: base.id, op: 'dry-run' })).rejects.toThrow(/only Jira administrators/);
    await expect(t.wb.confirmManual(t.as(t.signer), { blueprintId: base.id, designId: 'x' })).rejects.toThrow(/only Jira administrators/);
    await expect(t.wb.summary(t.as(t.admin), { blueprintId: '../state/x' })).rejects.toThrow(/invalid request/);
  });

  it('uploads in parts; a sign-off made elsewhere is kept in the history but must be renewed here', async () => {
    const t = setup();
    const r = await t.upload(t.admin, signedElsewhere(base));
    expect(r).toMatchObject({ blueprintId: base.id, replaced: false });
    const stored = parseBlueprint((await t.wb.store.read(`blueprints/${base.id}.json`))!, 'x');
    expect(stored.decisions.some((d) => d.id === 'd.sign-off.cli')).toBe(true);
    expect(stored.decisions.at(-1)).toMatchObject({ action: 'change', by: 'acc-admin' });
    expect(isSignedOff(stored)).toBe(false);
    await expect(t.upload(t.admin, base)).rejects.toThrow(/already in the workbench/);
    expect((await t.upload(t.admin, base, true)).replaced).toBe(true);

    // A sign-off dated a few minutes ahead (within skew) still ends up stale; further ahead is refused.
    const soon = new Date(Date.now() + 3 * 60_000).toISOString();
    await t.upload(t.admin, signedElsewhere(base, soon), true);
    expect(isSignedOff(parseBlueprint((await t.wb.store.read(`blueprints/${base.id}.json`))!, 'x'))).toBe(false);
    await expect(t.upload(t.admin, signedElsewhere(base, '2099-01-01T00:00:00Z'), true)).rejects.toThrow(/future date/);
    await expect(t.upload(t.admin, { ...base, outcomes: 'nope' }, true)).rejects.toThrow(/not a valid Migration Blueprint/);
  });

  it('refuses incomplete or mismatched uploads, and uploads of someone else', async () => {
    const t = setup();
    const { uploadId } = await t.wb.uploadStart(t.as(t.admin), { fileName: 'b.json', chars: 10, parts: 1 });
    await expect(t.wb.uploadFinish(t.as(t.admin), { uploadId })).rejects.toThrow(/incomplete/);
    await t.wb.uploadPart(t.as(t.admin), { uploadId, index: 0, text: '{"a":1}' });
    await expect(t.wb.uploadFinish(t.as(t.admin), { uploadId })).rejects.toThrow(/corrupt/);
    await expect(t.wb.uploadPart(t.as(t.admin), { uploadId, index: 1, text: 'x' })).rejects.toThrow(/part 1 of 1/);
    await expect(t.wb.uploadStart(t.as(t.admin), { fileName: 'b.json', chars: 10, parts: 3 })).rejects.toThrow(/need 1 parts/);
    const other: Caller = { ...t.admin, accountId: 'acc-admin-2' };
    t.as(t.admin);
    await expect(t.wb.uploadPart(other, { uploadId, index: 0, text: 'x' })).rejects.toThrow(/not found or expired/);
  });

  it('sign-off → dry-run job → designation → gated apply job → guided steps → verify, as the people who did them', async () => {
    const t = setup();
    await t.upload(t.admin, base);
    await t.wb.saveSettings(t.as(t.admin), { signers: ['acc-signer'] });

    const review = await t.wb.signOffReview(t.as(t.signer), { blueprintId: base.id });
    expect(review.phrase).toBe(signOffPhrase(review.signHash, base.id));
    await expect(t.wb.signOff(t.as(t.signer), { blueprintId: base.id, signHash: review.signHash, confirm: 'ok' })).rejects.toThrow(/exactly/);
    await t.wb.signOff(t.as(t.signer), { blueprintId: base.id, signHash: review.signHash, confirm: review.phrase! });
    const bp = parseBlueprint((await t.wb.store.read(`blueprints/${base.id}.json`))!, 'x');
    expect(bp.decisions.at(-1)).toMatchObject({ action: 'sign-off', by: 'acc-signer' });
    expect((await t.wb.bootstrap(t.as(t.admin))).blueprints[0]).toMatchObject({ id: base.id, signedOff: true });

    // Not designated: the dry-run works (Automation unreachable is fine) but offers no phrase, and apply is refused.
    const j1 = await t.wb.startJob(t.as(t.admin), { blueprintId: base.id, op: 'dry-run' });
    expect(t.queue[0]!.key).toBe(`bp-${base.id}`);
    await expect(t.wb.startJob(t.as(t.admin), { blueprintId: base.id, op: 'verify' })).rejects.toThrow(/already queued/);
    const d1 = await t.drain();
    expect(d1.status, d1.error).toBe('done');
    expect(t.actors.at(-1)).toEqual({ as: 'user', accountId: 'acc-admin' });
    const plan1 = d1.result as { planHash: string; phrase: string | null; apply: string };
    expect(plan1.phrase).toBeNull();
    expect(plan1.apply).toMatch(/sandbox designation/);
    await expect(t.wb.startJob(t.as(t.admin), { blueprintId: base.id, op: 'apply', planHash: plan1.planHash, confirm: confirmPhrase(plan1.planHash, t.site.siteUrl) })).rejects.toThrow(/not in the workbench sandbox designation/);

    await expect(t.wb.saveSettings(t.as(t.admin), { sandbox: { designate: true, confirm: 'yes' } })).rejects.toThrow(/DESIGNATE fake-sandbox.atlassian.net AS SANDBOX/);
    expect((await t.wb.saveSettings(t.as(t.admin), { sandbox: { designate: true, confirm: designatePhrase(t.site.siteUrl) } })).writeAllowed).toBe(true);

    await t.wb.startJob(t.as(t.admin), { blueprintId: base.id, op: 'dry-run' });
    const plan = (await t.drain()).result as { planHash: string; phrase: string };
    expect(plan.phrase).toBe(confirmPhrase(plan.planHash, t.site.siteUrl));
    await expect(t.wb.startJob(t.as(t.admin), { blueprintId: base.id, op: 'apply', planHash: plan.planHash, confirm: 'APPLY it' })).rejects.toThrow(/exactly/);
    expect(t.queue).toHaveLength(0);
    expect(t.site.writes).toHaveLength(0);

    const queued = await t.wb.startJob(t.as(t.admin), { blueprintId: base.id, op: 'apply', planHash: plan.planHash, confirm: plan.phrase });
    expect((await t.wb.job(t.as(t.signer), { blueprintId: base.id, jobId: queued.id }) as Record<string, unknown>).confirm).toBeUndefined();
    const applied = await t.drain();
    expect(applied.status, applied.error).toBe('done');
    expect(t.site.writes.length).toBeGreaterThan(0);
    expect((applied.result as { failed: unknown[] }).failed).toEqual([]);

    const s = await t.wb.summary(t.as(t.signer), { blueprintId: base.id });
    expect(s.status.exists).toBe(true);
    expect(s.jobs.map((j) => j.op)).toEqual(['apply', 'dry-run', 'dry-run']);
    const steps = await t.wb.manualSteps(t.as(t.signer), { blueprintId: base.id });
    expect(steps.count).toBeGreaterThan(0);
    // Automation could not be looked up from Forge, so its rule is a guided step rather than a failed dry-run.
    expect(steps.steps.map((x) => x.designId)).toEqual(expect.arrayContaining(bp.design.filter((d) => d.type === 'automation').map((d) => d.id)));
    expect(steps.steps.every((x) => x.markdown.length > 0)).toBe(true);
    const report = await t.wb.report(t.as(t.signer), { key: (applied.result as { report: string }).report });
    expect(report.markdown).toContain(plan.planHash);
    await expect(t.wb.report(t.as(t.signer), { key: `blueprints/${base.id}.json` })).rejects.toThrow(/not a report/);

    await t.wb.startJob(t.as(t.admin), { blueprintId: base.id, op: 'verify' });
    expect((await t.drain()).status).toBe('done');

    // Removing the designation stops writes again, even for a dry-run reviewed before.
    await t.wb.saveSettings(t.as(t.admin), { sandbox: { designate: false } });
    await t.wb.startJob(t.as(t.admin), { blueprintId: base.id, op: 'dry-run' });
    const again = (await t.drain()).result as { planHash: string };
    await expect(t.wb.startJob(t.as(t.admin), { blueprintId: base.id, op: 'apply', planHash: again.planHash, confirm: confirmPhrase(again.planHash, t.site.siteUrl) })).rejects.toThrow(/sandbox designation/);
  });

  it('never re-runs a retried job, runs jobs as the app when chosen, and frees a job the platform cut off', async () => {
    const t = setup();
    await t.upload(t.admin, base);
    await t.wb.saveSettings(t.as(t.admin), { actAs: 'app' });
    await t.wb.startJob(t.as(t.admin), { blueprintId: base.id, op: 'dry-run' });
    const msg = t.queue[0]!.msg;
    const retried = await t.drain(true);
    expect(retried).toMatchObject({ status: 'failed', error: expect.stringMatching(/not re-run automatically/) });
    expect(await t.wb.runJob(msg, { siteUrl: t.site.siteUrl, cloudId: t.admin.cloudId })).toMatchObject({ status: 'failed' });
    expect(t.actors).toHaveLength(0);

    await t.wb.startJob(t.as(t.admin), { blueprintId: base.id, op: 'dry-run' });
    expect((await t.drain()).status).toBe('done');
    expect(t.actors.every((a) => a.as === 'app')).toBe(true);

    // A queued job whose consumer never reported blocks for the time limit only.
    let now = Date.now();
    const wb2 = new Workbench({ ...t.wb.platform, now: () => new Date(now) });
    const stuck = await wb2.startJob(t.as(t.admin), { blueprintId: base.id, op: 'verify' });
    await expect(wb2.startJob(t.as(t.admin), { blueprintId: base.id, op: 'verify' })).rejects.toThrow(/already queued/);
    now += 21 * 60_000;
    await wb2.startJob(t.as(t.admin), { blueprintId: base.id, op: 'verify' });
    expect((await wb2.job(t.as(t.admin), { blueprintId: base.id, jobId: stuck.id }) as Job).status).toBe('failed');
  });
});

describe('ServiceNow connection', () => {
  const conn = (t: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) => ({
    instance: 'dev12345.service-now.com', grant: 'client_credentials', clientId: t.sn.creds.clientId, clientSecret: t.sn.creds.clientSecret, customer: 'Fixture Co', ...extra,
  });
  /** Run queued steps until the chain ends; returns the last job and how many invocations it took. */
  const drainAll = async (t: ReturnType<typeof setup>) => {
    let last: Job | undefined; let steps = 0;
    while (t.queue.length) { last = await t.drain(); steps++; }
    return { last: last!, steps };
  };

  it('stores secrets only in secret storage, never returns them, and reuses them only for the same client', async () => {
    const t = setup();
    await expect(t.wb.saveConnection(t.as(t.signer), conn(t))).rejects.toThrow(/only Jira administrators/);
    await expect(t.wb.saveConnection(t.as(t.admin), conn(t, { instance: 'evil.example.com' }))).rejects.toThrow(/service-now\.com/);
    await expect(t.wb.saveConnection(t.as(t.admin), conn(t, { clientSecret: '' }))).rejects.toThrow(/client secret/);
    await expect(t.wb.saveConnection(t.as(t.admin), conn(t, { grant: 'password' }))).rejects.toThrow(/integration user name/);
    expect((await t.wb.saveConnection(t.as(t.admin), conn(t, { customer: undefined }))).connection).toMatchObject({ customer: 'dev12345' });
    const saved = await t.wb.saveConnection(t.as(t.admin), conn(t));
    expect(saved).toMatchObject({ connection: { instance: t.sn.instanceUrl, usageDays: 365 }, hasClientSecret: true, hasPassword: false });
    expect(JSON.stringify(saved)).not.toContain(t.sn.creds.clientSecret);
    expect(JSON.stringify([...t.kv.data.values()])).not.toContain(t.sn.creds.clientSecret);

    // Same client, secret left blank: kept. A different client id needs the secret again.
    expect((await t.wb.saveConnection(t.as(t.admin), conn(t, { clientSecret: undefined, usageDays: 30 }))).connection).toMatchObject({ usageDays: 30 });
    await expect(t.wb.saveConnection(t.as(t.admin), conn(t, { clientSecret: undefined, clientId: 'other' }))).rejects.toThrow(/client secret/);

    await t.wb.removeConnection(t.as(t.admin));
    expect(await t.wb.connection(t.as(t.admin))).toMatchObject({ connection: null, hasClientSecret: false });
    expect(t.kv.secrets.size).toBe(0);
  });

  it('tests the connection step by step and explains a refused grant without echoing secrets', async () => {
    const t = setup();
    await t.wb.saveConnection(t.as(t.admin), conn(t));
    const ok = await t.wb.testConnection(t.as(t.admin));
    expect(ok).toMatchObject({ ok: true, release: 'Xanadu' });
    expect(ok.checks.map((c) => c.name)).toEqual(['OAuth token', 'Instance version (sys_properties)', 'Catalog items (Table API)', 'Counts (Aggregate API)']);
    expect((await t.wb.connection(t.as(t.admin))).connection?.lastTest).toMatchObject({ ok: true });
    expect(t.sn.requests.every((r) => r.method === 'GET' || r.path === '/oauth_token.do')).toBe(true);

    await t.wb.saveConnection(t.as(t.admin), conn(t, { clientSecret: 'wrong-secret-xyz' }));
    const bad = await t.wb.testConnection(t.as(t.admin));
    expect(bad.ok).toBe(false);
    expect(bad.checks).toHaveLength(1);
    expect(JSON.stringify(bad)).not.toContain('wrong-secret-xyz');

    // Password grant, for instances that do not allow client credentials.
    t.sn.allowClientCredentials = false;
    await t.wb.saveConnection(t.as(t.admin), conn(t, { grant: 'password', username: t.sn.creds.username, password: t.sn.creds.password }));
    expect((await t.wb.testConnection(t.as(t.admin))).ok).toBe(true);
  });

  it('collects across many invocations from checkpoints, then analyses into a blueprint that still needs sign-off', async () => {
    const t = setup({ collectBudgetMs: 5000, fakeClock: true });
    await t.wb.saveConnection(t.as(t.admin), conn(t, { usageDays: 30 }));
    const before = await t.wb.connection(t.as(t.admin));
    const job = await t.wb.startCollection(t.as(t.admin), {});
    await expect(t.wb.startCollection(t.as(t.admin), {})).rejects.toThrow(/already queued/);
    const { last, steps } = await drainAll(t);
    expect(steps).toBeGreaterThan(3);
    expect(last).toMatchObject({ id: job.id, status: 'done', result: { blueprintId: before.nextBlueprintId, replaced: false } });
    expect(t.sn.requests.every((r) => r.method === 'GET' || r.path === '/oauth_token.do')).toBe(true);

    const id = before.nextBlueprintId!;
    const bp = parseBlueprint((await t.wb.store.read(`blueprints/${id}.json`))!, 'x');
    expect(bp.outcomes.length).toBeGreaterThan(0);
    expect(isSignedOff(bp)).toBe(false);
    expect((await t.wb.bootstrap(t.as(t.admin))).blueprints.find((b: { id: string }) => b.id === id)).toMatchObject({ source: `ServiceNow ${new URL(t.sn.instanceUrl).host}` });
    expect(await t.wb.store.list(`collections/${job.id}/p/`)).toEqual([]);

    // A stale or duplicated step message does nothing.
    expect(await t.wb.runJob({ jobId: job.id, blueprintId: COLLECT, step: 1 }, { siteUrl: t.site.siteUrl, cloudId: t.admin.cloudId })).toMatchObject({ status: 'done' });
    expect(t.queue).toHaveLength(0);

    // Collecting the same blueprint again needs replace.
    await expect(t.wb.startCollection(t.as(t.admin), {})).rejects.toThrow(/already in the workbench/);
    await t.wb.startCollection(t.as(t.admin), { replace: true });
    expect((await drainAll(t)).last).toMatchObject({ status: 'done', result: { replaced: true } });
  });

  it('resumes a failed collection from its last checkpoint without reading everything again', async () => {
    const t = setup({ collectBudgetMs: 5000, fakeClock: true });
    await t.wb.saveConnection(t.as(t.admin), conn(t, { usageDays: 30 }));
    const job = await t.wb.startCollection(t.as(t.admin), {});
    await t.drain(); await t.drain();
    t.clock.down = true;
    const failed = await t.drain();
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.error).toMatch(/resumed/);
    expect(t.queue).toHaveLength(0);
    await expect(t.wb.resumeCollection(t.as(t.signer), { jobId: job.id })).rejects.toThrow(/only Jira administrators/);

    t.clock.down = false;
    const tokenAndInfo = t.sn.requests.filter((r) => r.path.includes('sys_properties')).length;
    await t.wb.resumeCollection(t.as(t.admin), { jobId: job.id });
    await expect(t.wb.resumeCollection(t.as(t.admin), { jobId: job.id })).rejects.toThrow(/only a failed collection/);
    expect((await drainAll(t)).last).toMatchObject({ id: job.id, status: 'done' });
    expect(t.sn.requests.filter((r) => r.path.includes('sys_properties')).length).toBe(tokenAndInfo); // the info phase is not repeated
  });
});

describe('ServiceNow collection, interrupted', () => {
  it('marks a collection that stopped making progress as failed, so it can be resumed', async () => {
    const t = setup({ collectBudgetMs: 5000, fakeClock: true });
    await t.wb.saveConnection(t.as(t.admin), { instance: 'dev12345.service-now.com', grant: 'client_credentials', clientId: 'client-1', clientSecret: 'secret-1', customer: 'Fixture Co' });
    const job = await t.wb.startCollection(t.as(t.admin), {});
    await t.drain();
    t.queue.length = 0; // the platform lost the next step
    t.clock.t += 21 * 60_000;
    const v = await t.wb.connection(t.as(t.admin));
    expect(v.jobs[0]).toMatchObject({ id: job.id, status: 'failed' });
    expect(v.jobs[0]!.error).toMatch(/resume/);
    await t.wb.resumeCollection(t.as(t.admin), { jobId: job.id });
    let last: Job | undefined;
    while (t.queue.length) last = await t.drain();
    expect(last).toMatchObject({ status: 'done' });
    expect((await t.wb.connection(t.as(t.admin))).jobs[0]!.result).toMatchObject({ blueprintId: v.nextBlueprintId });
  });
});

describe('blueprint views', () => {
  it('serves the ServiceNow and JSM views to signers, not to outsiders', async () => {
    const t = setup();
    await t.wb.saveSettings(t.as(t.admin), { signers: ['acc-signer'] });
    await t.upload(t.admin, base);
    const id = base.id;
    expect((await t.wb.inventory(t.as(t.signer), { blueprintId: id })).totals.components).toBe(base.evidence.length);
    expect((await t.wb.jsmGaps(t.as(t.signer), { blueprintId: id })).totals.elements).toBe(base.design.length);
    await expect(t.wb.inventory(t.as(t.outsider), { blueprintId: id })).rejects.toThrow(/do not have access/);
    await expect(t.wb.jsmGaps(t.as(t.admin), { blueprintId: 'nope' })).rejects.toThrow(/no blueprint/);
  });
});

describe('ServiceNow demo connection (basic auth) and request log', () => {
  const demo = (t: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) => ({
    profile: 'basic', instance: 'dev12345.service-now.com', username: t.sn.creds.username, password: t.sn.creds.password, ...extra,
  });

  it('is stored apart from the OAuth connection, and never returns or logs the password', async () => {
    const t = setup();
    await t.wb.saveConnection(t.as(t.admin), { instance: 'dev12345.service-now.com', grant: 'client_credentials', clientId: 'client-1', clientSecret: 'secret-1' });
    await expect(t.wb.saveConnection(t.as(t.admin), demo(t, { password: undefined }))).rejects.toThrow(/password/);
    await expect(t.wb.saveConnection(t.as(t.signer), demo(t))).rejects.toThrow(/only Jira administrators/);
    const v = await t.wb.saveConnection(t.as(t.admin), demo(t));
    expect(v).toMatchObject({ profile: 'basic', connection: { grant: 'basic', username: t.sn.creds.username, customer: 'dev12345' }, hasPassword: true });
    expect((await t.wb.connection(t.as(t.admin))).connection).toMatchObject({ grant: 'client_credentials' });
    // Same instance and user: the stored password is kept.
    await t.wb.saveConnection(t.as(t.admin), demo(t, { password: undefined, usageDays: 30 }));
    const tested = await t.wb.testConnection(t.as(t.admin), { profile: 'basic' });
    expect(tested.checks.filter((x) => !x.ok)).toEqual([]);

    const everything = JSON.stringify([...t.kv.data.values(), v, await t.wb.snLogs(t.as(t.admin), { profile: 'basic' })]);
    expect(everything).not.toContain(t.sn.creds.password);
    expect(everything).not.toContain(Buffer.from(`${t.sn.creds.username}:${t.sn.creds.password}`).toString('base64'));
    await t.wb.removeConnection(t.as(t.admin), { profile: 'basic' });
    expect((await t.wb.connection(t.as(t.admin), { profile: 'basic' })).connection).toBeNull();
    expect((await t.wb.connection(t.as(t.admin))).connection).not.toBeNull();
  });

  it('logs each request and check, newest first, with ServiceNow\'s answer on failures', async () => {
    const t = setup();
    await t.wb.saveConnection(t.as(t.admin), demo(t, { password: 'wrong-pw' }));
    const bad = await t.wb.testConnection(t.as(t.admin), { profile: 'basic' });
    expect(bad.ok).toBe(false);
    expect(bad.checks[0]).toMatchObject({ name: 'Sign in (basic auth)', ok: false });
    expect(bad.checks[0]!.detail).toMatch(/user name or password \(401\)/);
    const { entries } = await t.wb.snLogs(t.as(t.admin), { profile: 'basic' });
    expect(entries[0]).toMatchObject({ kind: 'event', level: 'error', message: 'test failed' });
    const http = entries.filter((e) => e.kind === 'http');
    expect(http.length).toBeGreaterThan(0);
    expect(http[0]).toMatchObject({ method: 'GET', status: 401 });
    expect(http[0]!.kind === 'http' && http[0]!.detail).toMatch(/User Not Authenticated/);
    expect(JSON.stringify(entries)).not.toContain('wrong-pw');
    expect((await t.wb.snLogs(t.as(t.admin))).entries).toEqual([]); // the OAuth log is separate
    await expect(t.wb.snLogs(t.as(t.signer), { profile: 'basic' })).rejects.toThrow(/only Jira administrators/);
    expect((await t.wb.clearSnLogs(t.as(t.admin), { profile: 'basic' })).entries).toEqual([]);
    expect((await t.wb.snLogs(t.as(t.admin), { profile: 'basic' })).entries).toEqual([]);
  });

  it('collects with basic auth into a blueprint, listing the job and a bounded log under the demo connection only', async () => {
    const t = setup({ collectBudgetMs: 5000, fakeClock: true });
    await t.wb.saveConnection(t.as(t.admin), demo(t, { usageDays: 30 }));
    const job = await t.wb.startCollection(t.as(t.admin), { profile: 'basic' });
    let last: Job | undefined;
    while (t.queue.length) last = await t.drain();
    expect(last).toMatchObject({ id: job.id, status: 'done', collect: { profile: 'basic' } });
    expect((await t.wb.connection(t.as(t.admin), { profile: 'basic' })).jobs.map((j) => j.id)).toEqual([job.id]);
    expect((await t.wb.connection(t.as(t.admin))).jobs).toEqual([]);
    const { entries } = await t.wb.snLogs(t.as(t.admin), { profile: 'basic' });
    expect(entries.length).toBeLessThanOrEqual(250);
    expect(entries[0]).toMatchObject({ kind: 'event', message: expect.stringMatching(/done: blueprint .* from \d+ records/) });
    expect(t.sn.requests.every((r) => r.method === 'GET')).toBe(true);
  });
});

describe('ServiceNow collection and Forge limits', () => {
  it('stores pages compressed and per table, and waits out a Forge limit instead of failing', async () => {
    const t = setup({ collectBudgetMs: 5000, fakeClock: true });
    await t.wb.saveConnection(t.as(t.admin), { profile: 'basic', instance: 'dev12345.service-now.com', username: t.sn.creds.username, password: t.sn.creds.password, usageDays: 30 });
    const job = await t.wb.startCollection(t.as(t.admin), { profile: 'basic' });
    await t.drain(); await t.drain();
    const pages = await t.wb.store.list(`collections/${job.id}/p/`);
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.every((k) => /\/p\/[a-z0-9_]+\/\d{6}\.gz$/.test(k))).toBe(true);

    // The installation goes over a Forge limit for a while: the step is queued again with a delay, twice.
    const set = t.kv.set.bind(t.kv);
    let refusals = 2;
    t.kv.set = async (key, value, o) => {
      if (key.includes('collections') && refusals > 0) { refusals--; throw new Error('Limits for the current installation have been exceeded'); }
      return set(key, value, o);
    };
    const waiting = await t.drain();
    expect(waiting).toMatchObject({ status: 'running', limitRetries: 1 });
    expect(t.queue[0]).toMatchObject({ delay: 300 });
    expect((await t.drain())).toMatchObject({ status: 'running', limitRetries: 2 });
    let last: Job | undefined;
    while (t.queue.length) last = await t.drain();
    expect(last).toMatchObject({ id: job.id, status: 'done' });
    const { entries } = await t.wb.snLogs(t.as(t.admin), { profile: 'basic' });
    expect(entries.some((e) => e.kind === 'event' && /Forge limit reached.*retry 1 of 6/.test(e.message))).toBe(true);
  });

  it('removes the stored pages of earlier collections when a new one starts', async () => {
    const t = setup({ collectBudgetMs: 5000, fakeClock: true });
    await t.wb.saveConnection(t.as(t.admin), { profile: 'basic', instance: 'dev12345.service-now.com', username: t.sn.creds.username, password: t.sn.creds.password, usageDays: 30 });
    const first = await t.wb.startCollection(t.as(t.admin), { profile: 'basic' });
    await t.drain(); await t.drain();
    t.clock.down = true; await t.drain(); t.clock.down = false;
    expect((await t.wb.store.list(`collections/${first.id}/`)).length).toBeGreaterThan(0);
    await t.wb.startCollection(t.as(t.admin), { profile: 'basic' });
    expect(await t.wb.store.list(`collections/${first.id}/`)).toEqual([]);
    await expect(t.wb.resumeCollection(t.as(t.admin), { jobId: first.id })).rejects.toThrow(/nothing to resume|already/);
  });

  it('fails with a resumable, plain message once the limit outlasts the retries', async () => {
    const t = setup({ collectBudgetMs: 5000, fakeClock: true });
    await t.wb.saveConnection(t.as(t.admin), { profile: 'basic', instance: 'dev12345.service-now.com', username: t.sn.creds.username, password: t.sn.creds.password, usageDays: 30 });
    await t.wb.startCollection(t.as(t.admin), { profile: 'basic' });
    await t.drain();
    const set = t.kv.set.bind(t.kv);
    t.kv.set = async (key, value, o) => {
      if (key.includes('collections')) throw new Error('Limits for the current installation have been exceeded');
      return set(key, value, o);
    };
    let last: Job | undefined;
    while (t.queue.length) last = await t.drain();
    expect(last).toMatchObject({ status: 'failed', limitRetries: 6 });
    expect(last!.error).toMatch(/Forge limits for this installation were exceeded.*resume/);
  });
});
