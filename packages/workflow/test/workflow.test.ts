import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotFromXml } from '@snjsm/collector';
import { analyse } from '@snjsm/analyser';
import { FakeSite } from '@snjsm/builder';
import { BuildService, checkKey, confirmPhrase, MemoryStore, signOffPhrase } from '@snjsm/workflow';

// The workflow must run on any Store (Forge storage in the workbench), with no file system behind it.
const xml = readFileSync(join(__dirname, '../../collector/test/fixtures/enterprise-update-set.xml'), 'utf8');
const base = analyse(snapshotFromXml([{ name: 'enterprise.xml', xml }]), { customer: 'Fixture Co', now: '2026-01-01T00:00:00Z' }).blueprint;

function setup(o: { writeSites?: string[] } = {}) {
  const store = new MemoryStore();
  store.data.set('bp/blueprint.json', JSON.stringify(base));
  const site = new FakeSite();
  const svc = new BuildService({
    store, writeSites: o.writeSites ?? [site.siteUrl], writeSitesHint: 'the sandbox setting', allowUnsigned: false, by: 'acc-123', defaultSite: site.siteUrl,
    clientFor: (_s, ro) => site.client(ro),
  });
  return { store, site, svc, blueprint: 'bp/blueprint.json' };
}

describe('storage keys', () => {
  it('refuses keys that could escape a prefix', () => {
    for (const k of ['', '/abs', '../x', 'a/../b', 'a//b', './a', 'C:/x', 'a\\..\\b']) expect(() => checkKey(k)).toThrow(/invalid storage key/);
    expect(checkKey('state/bp.x@site.atlassian.net.json')).toBe('state/bp.x@site.atlassian.net.json');
  });

  it('memory store refuses a second holder of a lock instead of queueing it', async () => {
    const store = new MemoryStore();
    let inner: unknown;
    await store.lock('state/a.json', async () => { inner = await store.lock('state/a.json', async () => 1).catch((e: Error) => e.message); });
    expect(inner).toMatch(/locked by another run/);
    expect(await store.lock('state/a.json', async () => 2)).toBe(2);
  });
});

describe('workflow on a memory store', () => {
  it('signs off, dry-runs, applies behind the gates and records state, with no file system', async () => {
    const { store, site, svc, blueprint } = setup();
    const review = await svc.signOffReview({ blueprint });
    expect(review.phrase).toBe(signOffPhrase(review.signHash, base.id));
    expect(await svc.readReport(review.files.markdown)).toContain(review.phrase);
    await svc.signOff({ blueprint, signHash: review.signHash, confirm: review.phrase! });
    expect((await svc.loadBlueprint(blueprint)).decisions.at(-1)).toMatchObject({ action: 'sign-off', by: 'acc-123' });

    const d = await svc.plan({ blueprint, dryRun: true });
    expect(d.phrase).toBe(confirmPhrase(d.planHash, site.siteUrl));
    await expect(svc.checkApply({ blueprint, planHash: d.planHash, confirm: 'yes' })).rejects.toThrow(/exactly/);
    await expect(svc.checkApply({ blueprint, planHash: d.planHash, confirm: d.phrase! })).resolves.toMatchObject({ site: site.siteUrl });
    expect(site.writes).toHaveLength(0);

    const r = await svc.apply({ blueprint, planHash: d.planHash, confirm: d.phrase! });
    expect(r.failed).toEqual([]);
    expect(site.writes.length).toBeGreaterThan(0);
    expect(store.data.has(r.state)).toBe(true);
    expect(JSON.parse(store.data.get(r.state)!)).toMatchObject({ blueprintId: base.id, site: site.siteUrl });
    expect(await svc.readReport(r.report)).toContain(d.planHash);
    expect((await svc.status({ blueprint })).exists).toBe(true);
    expect([...store.data.keys()].every((k) => checkKey(k) === k)).toBe(true);
  });

  it('refuses writes to a site that is not designated, naming how to allow it', async () => {
    const { svc, blueprint, site } = setup({ writeSites: [] });
    const review = await svc.signOffReview({ blueprint });
    await svc.signOff({ blueprint, signHash: review.signHash, confirm: review.phrase! });
    const d = await svc.plan({ blueprint, dryRun: true });
    await expect(svc.apply({ blueprint, planHash: d.planHash, confirm: confirmPhrase(d.planHash, site.siteUrl) })).rejects.toThrow(/not in the sandbox setting/);
    expect(site.writes).toHaveLength(0);
  });

  it('refuses a second apply while one holds the state, and reads only reports', async () => {
    const { store, svc, blueprint, site } = setup();
    const review = await svc.signOffReview({ blueprint });
    await svc.signOff({ blueprint, signHash: review.signHash, confirm: review.phrase! });
    const d = await svc.plan({ blueprint, dryRun: true });
    const state = `state/${base.id}@${new URL(site.siteUrl).hostname}.json`;
    await store.lock(state, async () => {
      await expect(svc.apply({ blueprint, planHash: d.planHash, confirm: d.phrase! })).rejects.toThrow(/locked by another run/);
    });
    expect(site.writes).toHaveLength(0);
    await expect(svc.readReport(blueprint)).rejects.toThrow(/not a report/);
    await expect(svc.readReport(state)).rejects.toThrow(/not a report/);
    await expect(svc.readReport('plans/missing.md')).rejects.toThrow(/not found/);
  });
});
