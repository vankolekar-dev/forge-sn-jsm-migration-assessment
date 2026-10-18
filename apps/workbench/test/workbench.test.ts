import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotFromXml } from '@snjsm/collector';
import { analyse } from '@snjsm/analyser';
import { UnreachableError } from '@snjsm/atlassian';
import { FakeSite, isSignedOff, type SiteApi } from '@snjsm/builder';
import type { Blueprint } from '@snjsm/model';
import { confirmPhrase, parseBlueprint, signOffPhrase } from '@snjsm/workflow';
import { CHUNK_CHARS, MemoryKv } from '../src/kv-store';
import { designatePhrase, Workbench, type Actor, type Caller, type Job, type JobMessage } from '../src/workbench';

const xml = readFileSync(join(__dirname, '../../../packages/collector/test/fixtures/enterprise-update-set.xml'), 'utf8');
const base = analyse(snapshotFromXml([{ name: 'enterprise.xml', xml }]), { customer: 'Fixture Co', now: '2026-01-01T00:00:00Z' }).blueprint;
const signedElsewhere = (bp: Blueprint, at = '2026-01-02T00:00:00Z'): Blueprint => ({ ...bp, decisions: [...bp.decisions, { id: 'd.sign-off.cli', at, by: 'someone', subject: { kind: 'blueprint', id: bp.id }, action: 'sign-off' }] });

/** A FakeSite seen through Forge: api.atlassian.com product APIs (Automation) are unreachable. */
function forgeView(c: SiteApi): SiteApi {
  return { ...c, call: async (m: string, url: string) => { throw new UnreachableError(m, url.replace(/^https:\/\/[^/]+/, ''), 'test'); } } as SiteApi;
}

function setup() {
  const site = new FakeSite();
  const kv = new MemoryKv();
  const queue: { msg: JobMessage; key: string }[] = [];
  const actors: Actor[] = [];
  const who = { admin: true };
  const wb = new Workbench({
    kv,
    client: (actor, ro) => { actors.push(actor); return forgeView(site.client(ro)); },
    isAdmin: async () => who.admin,
    enqueue: async (msg, key) => { queue.push({ msg, key }); },
  });
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
  return { site, kv, wb, queue, actors, admin, signer, outsider, as, upload, drain };
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
