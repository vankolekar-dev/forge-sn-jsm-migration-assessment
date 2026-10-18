import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { snapshotFromXml } from '@snjsm/collector';
import { analyse } from '@snjsm/analyser';
import { FakeSite } from '@snjsm/builder';
import type { Blueprint } from '@snjsm/model';
import { BuildService, configFromEnv, confirmPhrase, createServer, FsStore, signOffPhrase } from '@snjsm/mcp-server';

const xml = readFileSync(join(__dirname, '../../collector/test/fixtures/enterprise-update-set.xml'), 'utf8');
const base = analyse(snapshotFromXml([{ name: 'enterprise.xml', xml }]), { customer: 'Fixture Co', now: '2026-01-01T00:00:00Z' }).blueprint;
const signed = (bp: Blueprint): Blueprint => ({ ...bp, decisions: [...bp.decisions, { id: 'd.sign-off', at: '2026-01-02T00:00:00Z', by: 'vish', subject: { kind: 'blueprint', id: bp.id }, action: 'sign-off' }] });

function setup(o: { bp?: Blueprint; writeSites?: string[]; allowUnsigned?: boolean } = {}) {
  const workdir = mkdtempSync(join(tmpdir(), 'snjsm-mcp-'));
  mkdirSync(join(workdir, 'fx'));
  writeFileSync(join(workdir, 'fx/blueprint.json'), JSON.stringify(o.bp ?? signed(base)));
  const site = new FakeSite();
  const svc = new BuildService({
    store: new FsStore(workdir), writeSites: o.writeSites ?? [site.siteUrl], allowUnsigned: o.allowUnsigned ?? false, by: 'tester', defaultSite: site.siteUrl,
    clientFor: (s, ro) => { expect(s).toBe(site.siteUrl); return site.client(ro); },
  });
  return { workdir, site, svc, blueprint: 'fx/blueprint.json' };
}

describe('config and file guard', () => {
  it('reads env: apply is disabled unless sites are allowlisted', () => {
    const c = configFromEnv({ SNJSM_WRITE_SITES: 'a-sandbox.atlassian.net, https://B.atlassian.net', SNJSM_SITE: 'a-sandbox' + '.atlassian.net' }, () => { throw new Error('x'); }, '/w');
    expect(c).toMatchObject({ workdir: '/w/out', defaultSite: 'https://a-sandbox.atlassian.net', writeSites: ['https://a-sandbox.atlassian.net', 'https://b.atlassian.net'], allowUnsigned: false });
    expect(configFromEnv({}, () => { throw new Error('x'); }, '/w').writeSites).toEqual([]);
  });
  it('refuses keys outside the work directory', async () => {
    const { svc } = setup();
    await expect(svc.loadBlueprint('../../etc/passwd')).rejects.toThrow(/invalid storage key/);
    await expect(svc.loadBlueprint('/etc/passwd')).rejects.toThrow(/invalid storage key/);
    await expect(svc.loadBlueprint('nope.json')).rejects.toThrow(/not found/);
  });

  it('file store: atomic writes, listing, symlinks out refused, exclusive locks', async () => {
    const { workdir } = setup();
    const store = new FsStore(workdir);
    const outside = mkdtempSync(join(tmpdir(), 'snjsm-outside-'));
    writeFileSync(join(outside, 'secret.json'), '{}');
    symlinkSync(outside, join(workdir, 'link'));
    await expect(store.read('link/secret.json')).rejects.toThrow(/outside the work directory/);
    await expect(store.write('link/x.json', '{}')).rejects.toThrow(/outside the work directory/);
    await store.write('state/a@x.json', 'one');
    await store.write('state/deep/b.json', 'two');
    expect(await store.read('state/a@x.json')).toBe('one');
    expect(await store.list('state/')).toEqual(['state/a@x.json', 'state/deep/b.json']);
    expect(await store.list('nothing/')).toEqual([]);
    const held = store.lock('state/a@x.json', async () => {
      expect(existsSync(join(workdir, 'state/a@x.json.lock'))).toBe(true);
      expect(await store.list('state/')).toEqual(['state/a@x.json', 'state/deep/b.json']);
      await expect(store.lock('state/a@x.json', async () => 1)).rejects.toThrow(/locked by another run/);
      return 7;
    });
    expect(await held).toBe(7);
    expect(existsSync(join(workdir, 'state/a@x.json.lock'))).toBe(false);
  });
});

describe('build service', () => {
  it('plans offline and writes the plan; offline plans cannot be applied', async () => {
    const { svc, blueprint, workdir, site } = setup();
    const p = await svc.plan({ blueprint });
    expect(p.mode).toBe('offline');
    expect(existsSync(join(workdir, p.files.json))).toBe(true);
    expect(p.apply).toMatch(/offline/);
    await expect(svc.apply({ blueprint, planHash: p.planHash, confirm: confirmPhrase(p.planHash, site.siteUrl) })).rejects.toThrow(/no dry-run|not a dry-run|changed|differs/);
    expect(site.writes).toHaveLength(0);
  });

  it('gates apply: allowlist, exact phrase, sign-off', async () => {
    const off = setup({ writeSites: [] });
    const d0 = await off.svc.plan({ blueprint: off.blueprint, dryRun: true });
    expect(d0.apply).toMatch(/disabled/);
    await expect(off.svc.apply({ blueprint: off.blueprint, planHash: d0.planHash, confirm: confirmPhrase(d0.planHash, off.site.siteUrl) })).rejects.toThrow(/not in SNJSM_WRITE_SITES/);

    const on = setup();
    const d = await on.svc.plan({ blueprint: on.blueprint, dryRun: true });
    await expect(on.svc.apply({ blueprint: on.blueprint, planHash: d.planHash, confirm: 'yes' })).rejects.toThrow(/exactly/);
    await expect(on.svc.apply({ blueprint: on.blueprint, planHash: 'deadbeef', confirm: confirmPhrase('deadbeef', on.site.siteUrl) })).rejects.toThrow(/no dry-run/);

    const unsigned = setup({ bp: base });
    const du = await unsigned.svc.plan({ blueprint: unsigned.blueprint, dryRun: true });
    await expect(unsigned.svc.apply({ blueprint: unsigned.blueprint, planHash: du.planHash, confirm: confirmPhrase(du.planHash, unsigned.site.siteUrl) })).rejects.toThrow(/not signed off/);
    for (const x of [off, on, unsigned]) expect(x.site.writes).toHaveLength(0);
  });

  it('dry-run → apply → guided steps → confirm → apply → verify, with state on disk', async () => {
    const { svc, blueprint, site, workdir } = setup();
    const go = async () => {
      const d = await svc.plan({ blueprint, dryRun: true });
      return svc.apply({ blueprint, planHash: d.planHash, confirm: confirmPhrase(d.planHash, site.siteUrl) });
    };
    const d = await svc.plan({ blueprint, dryRun: true });
    expect(site.writes).toHaveLength(0);
    expect(d.apply).toContain(confirmPhrase(d.planHash, site.siteUrl));
    const r = await svc.apply({ blueprint, planHash: d.planHash, confirm: confirmPhrase(d.planHash, site.siteUrl) });
    expect(r.summary.done).toBeGreaterThan(5);
    expect(r.failed).toEqual([]);
    expect(existsSync(join(workdir, r.state))).toBe(true);
    expect(existsSync(join(workdir, `${r.state}.lock`))).toBe(false);

    const st = await svc.status({ blueprint });
    expect(st.exists).toBe(true);
    expect(st.elements.recorded).toBeGreaterThan(10);

    // Guided step: create the Assets schema from its template in the UI, then record its id.
    const m = await svc.manualSteps({ blueprint });
    expect(m.count).toBeGreaterThan(0);
    const schemaStep = m.steps.find((s) => s.designId === 'as.schema.itam')!;
    expect(schemaStep.record).toBe('remote-id');
    await expect(svc.confirmManual({ blueprint, designId: 'as.schema.itam' })).rejects.toThrow(/record the site id/);
    const schema = site.createSchemaFromTemplate('atl.assets.template.itam', 'IT assets', 'ITAM');
    expect((await svc.confirmManual({ blueprint, designId: 'as.schema.itam', remoteId: schema.id })).status).toBe('manual-done');

    // The next run binds the template's object types and creates only the extensions.
    const r2 = await go();
    expect(r2.failed).toEqual([]);
    expect(site.objectTypes.filter((t) => t.objectSchemaId === schema.id).map((t) => t.name)).toEqual(expect.arrayContaining(['Hardware Models', 'Person']));

    const ref = (await svc.manualSteps({ blueprint })).steps.find((s) => s.designId === 'ref.reports-to')!;
    expect(ref.record).toBe('remote-id');
    const before = (await svc.manualSteps({ blueprint })).count;
    const c = await svc.confirmManual({ blueprint, designId: 'ref.reports-to', remoteId: '77' });
    expect(c.status).toBe('manual-done');
    expect((await svc.manualSteps({ blueprint })).count).toBe(before - 1);

    // The attribute waiting on the reference type is now plannable.
    const d2 = await svc.plan({ blueprint, dryRun: true, elementIds: ['as.attr.person-manager'] });
    expect(d2.summary.blocked ?? 0).toBe(0);

    const v = await svc.verify({ blueprint });
    expect(v.summary.ok).toBeGreaterThan(5);
    expect(v.summary.missing).toBe(0);
  });

  it('carries confirmed guided steps forward to a re-analysed blueprint on the same site, only when the design is identical', async () => {
    const { svc, blueprint, site, workdir } = setup();
    const go = async (b: string) => {
      const d = await svc.plan({ blueprint: b, dryRun: true });
      return { d, r: await svc.apply({ blueprint: b, planHash: d.planHash, confirm: confirmPhrase(d.planHash, site.siteUrl) }) };
    };
    await go(blueprint);
    const schema = site.createSchemaFromTemplate('atl.assets.template.itam', 'IT assets', 'ITAM');
    await svc.confirmManual({ blueprint, designId: 'as.schema.itam', remoteId: schema.id, remoteKey: 'ITAM', note: 'made from the ITAM template' });

    // Re-analysis: same design, new id. One copy also changes the schema's design.
    const v1 = signed(base);
    const next = { ...v1, id: `${base.id}-b` };
    const changed = { ...v1, id: `${base.id}-c`, design: v1.design.map((el) => (el.id === 'as.schema.itam' ? { ...el, name: `${el.name} (renamed)` } : el)) };
    writeFileSync(join(workdir, 'fx/next.json'), JSON.stringify(next));
    writeFileSync(join(workdir, 'fx/changed.json'), JSON.stringify(changed));

    const c = await svc.plan({ blueprint: 'fx/changed.json', dryRun: true });
    expect(c.carried.map((x) => x.designId)).not.toContain('as.schema.itam');

    const writes = site.writes.length;
    const d = await svc.plan({ blueprint: 'fx/next.json', dryRun: true });
    expect(site.writes).toHaveLength(writes);
    expect(d.carried).toEqual([expect.objectContaining({ designId: 'as.schema.itam', fromBlueprint: base.id, by: 'tester', remote: expect.objectContaining({ id: schema.id }), note: 'made from the ITAM template' })]);
    expect(readFileSync(join(workdir, d.files.markdown), 'utf8')).toContain('Guided steps carried forward');
    expect((await svc.manualSteps({ blueprint: 'fx/next.json' })).steps.map((s) => s.designId)).toContain('as.schema.itam');

    const r = await svc.apply({ blueprint: 'fx/next.json', planHash: d.planHash, confirm: confirmPhrase(d.planHash, site.siteUrl) });
    expect(r.failed).toEqual([]);
    const state = JSON.parse(readFileSync(join(workdir, r.state), 'utf8'));
    expect(state.elements['as.schema.itam']).toMatchObject({ status: 'manual-done', by: 'tester', remote: { id: schema.id }, note: expect.stringContaining(`carried forward from ${base.id}`) });
    expect(state.runs.some((x: { op: string }) => x.op === 'carry-forward')).toBe(true);
    // The Assets types that waited on the schema were bound in the same run, and nothing is carried twice.
    expect(state.elements['as.ot.hardware-model']?.remote).toBeTruthy();
    expect((await svc.manualSteps({ blueprint: 'fx/next.json' })).steps.map((s) => s.designId)).not.toContain('as.schema.itam');
    expect((await svc.plan({ blueprint: 'fx/next.json', dryRun: true })).carried).toEqual([]);
  });

  it('sets the target space, records the decision and makes the sign-off stale', async () => {
    const { svc, blueprint, site } = setup();
    expect((await svc.summary({ blueprint })).signedOff).toBe(true);
    await expect(svc.setSpace({ blueprint, mode: 'existing' })).rejects.toThrow(/needs its key/);
    await expect(svc.setSpace({ blueprint, mode: 'new', key: 'bad key' })).rejects.toThrow(/invalid space key/);
    const r = await svc.setSpace({ blueprint, mode: 'existing', key: 'its' });
    expect(r).toMatchObject({ designId: 'sp.it-service-desk', after: { mode: 'existing', key: 'ITS' }, signedOff: false });
    expect(r.next).toMatch(/sign off again/);
    const s = await svc.summary({ blueprint });
    expect(s.spaces).toEqual([{ designId: 'sp.it-service-desk', name: expect.any(String), mode: 'existing', key: 'ITS' }]);
    expect((await svc.loadBlueprint(blueprint)).decisions.at(-1)).toMatchObject({ action: 'change', subject: { kind: 'design-element', id: 'sp.it-service-desk' } });
    const d = await svc.plan({ blueprint, dryRun: true });
    expect(d.warnings.some((w) => /ITS was not found/.test(w))).toBe(true);
    await expect(svc.apply({ blueprint, planHash: d.planHash, confirm: confirmPhrase(d.planHash, site.siteUrl) })).rejects.toThrow(/not signed off/);
    expect(site.writes).toHaveLength(0);
  });

  it('signs off only the reviewed blueprint, with the exact phrase, and records who decided what', async () => {
    const { svc, blueprint, workdir } = setup({ bp: base });
    const r = await svc.signOffReview({ blueprint });
    expect(r.signedOff).toBe(false);
    expect(r.outcomes.length).toBe(base.outcomes.length);
    expect(readFileSync(join(workdir, r.files.markdown), 'utf8')).toContain(signOffPhrase(r.signHash, base.id));

    const phrase = signOffPhrase(r.signHash, base.id);
    await expect(svc.signOff({ blueprint, signHash: r.signHash, confirm: 'yes' })).rejects.toThrow(/exactly/);
    await expect(svc.signOff({ blueprint, signHash: 'deadbeefdeadbeef', confirm: phrase })).rejects.toThrow(/changed since it was reviewed/);
    await expect(svc.signOff({ blueprint, signHash: r.signHash, confirm: phrase, reject: ['nope'] })).rejects.toThrow(/no outcome nope/);
    await expect(svc.signOff({ blueprint, signHash: r.signHash, confirm: phrase, reject: base.outcomes.map((o) => o.id) })).rejects.toThrow(/nothing to sign off/);
    expect((await svc.loadBlueprint(blueprint)).decisions).toHaveLength(base.decisions.length);

    const deferred = base.outcomes.at(-1)!.id;
    const s = await svc.signOff({ blueprint, signHash: r.signHash, confirm: phrase, defer: [deferred], comment: 'sandbox review' });
    expect(s).toMatchObject({ signedOff: true, by: 'tester', deferred: [deferred], rejected: [] });
    expect(s.confirmed).toHaveLength(base.outcomes.length - 1);
    const bp = await svc.loadBlueprint(blueprint);
    expect(bp.outcomes.find((o) => o.id === deferred)?.status).toBe('deferred');
    expect(bp.outcomes.filter((o) => o.status === 'confirmed')).toHaveLength(base.outcomes.length - 1);
    const so = bp.decisions.at(-1)!;
    expect(so).toMatchObject({ action: 'sign-off', by: 'tester', subject: { kind: 'blueprint', id: base.id }, comment: 'sandbox review', after: { signHash: r.signHash } });
    expect(bp.decisions.filter((d) => d.subject.kind === 'outcome')).toHaveLength(base.outcomes.length);
    await expect(svc.signOff({ blueprint, signHash: r.signHash, confirm: phrase })).rejects.toThrow(/changed since it was reviewed/);
    const signed1 = await svc.signOffReview({ blueprint });
    expect(signed1.signedOff).toBe(true);
    await expect(svc.signOff({ blueprint, signHash: signed1.signHash, confirm: signOffPhrase(signed1.signHash, base.id) })).rejects.toThrow(/already signed off.*reject, defer or reinstate/);

    // Amend: defer one more outcome, then reinstate both; each step is a reviewed, recorded sign-off.
    const second = base.outcomes[0]!.id;
    const am = await svc.signOff({ blueprint, signHash: signed1.signHash, confirm: signOffPhrase(signed1.signHash, base.id), defer: [second] });
    expect(am).toMatchObject({ signedOff: true, deferred: expect.arrayContaining([deferred, second]) });
    expect((await svc.loadBlueprint(blueprint)).decisions.at(-1)).toMatchObject({ action: 'sign-off', after: { amends: true } });
    const r3 = await svc.signOffReview({ blueprint });
    const back = await svc.signOff({ blueprint, signHash: r3.signHash, confirm: signOffPhrase(r3.signHash, base.id), reinstate: [deferred, second] });
    expect(back.deferred).toEqual([]);
    expect(back.confirmed).toHaveLength(base.outcomes.length);
    await expect(svc.signOff({ blueprint, signHash: r3.signHash, confirm: 'x', defer: [second], reinstate: [second] })).rejects.toThrow();

    // A later design change makes it stale; a fresh review has a new hash and the old one is refused.
    await svc.setSpace({ blueprint, mode: 'existing', key: 'ZZREF' });
    expect((await svc.signOffReview({ blueprint })).signedOff).toBe(false);
    const again = await svc.signOffReview({ blueprint });
    expect(again.signHash).not.toBe(r.signHash);
    await expect(svc.signOff({ blueprint, signHash: r.signHash, confirm: phrase })).rejects.toThrow(/changed since it was reviewed/);
    expect((await svc.signOff({ blueprint, signHash: again.signHash, confirm: signOffPhrase(again.signHash, base.id) })).signedOff).toBe(true);
  });

  it('breaks the work into one epic per capability', async () => {
    const { svc, blueprint } = setup();
    const w = await svc.workBreakdown({ blueprint });
    expect(w.epics.length).toBeGreaterThan(0);
    expect(w.epics.every((e) => e.items.length > 0)).toBe(true);
  });
});

describe('MCP protocol', () => {
  it('lists the tools and returns errors as tool errors, not crashes', async () => {
    const { svc, blueprint, site } = setup();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer(svc).connect(a);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(b);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['acceptance_cleanup', 'acceptance_plan', 'acceptance_run', 'blueprint_set_space', 'blueprint_summary', 'build_apply', 'build_confirm_manual', 'build_manual_steps', 'build_plan', 'build_status', 'build_verify', 'build_work_breakdown', 'signoff_record', 'signoff_review']);
    expect(tools.find((t) => t.name === 'build_plan')?.annotations?.readOnlyHint).toBe(true);

    const s = await client.callTool({ name: 'blueprint_summary', arguments: { blueprint } });
    expect(s.isError).toBeFalsy();
    expect(JSON.parse((s.content as { text: string }[])[0]!.text)).toMatchObject({ id: base.id, signedOff: true, writeAllowed: true });

    const p = await client.callTool({ name: 'build_plan', arguments: { blueprint, dryRun: true } });
    const hash = JSON.parse((p.content as { text: string }[])[0]!.text).planHash as string;
    const bad = await client.callTool({ name: 'build_apply', arguments: { blueprint, planHash: hash, confirm: 'go ahead' } });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0]!.text).toMatch(/exactly/);
    expect(site.writes).toHaveLength(0);
    await client.close();
  });
});
