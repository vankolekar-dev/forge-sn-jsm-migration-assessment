import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { snapshotFromXml } from '@snjsm/collector';
import { analyse } from '@snjsm/analyser';
import { FakeSite } from '@snjsm/builder';
import type { Blueprint } from '@snjsm/model';
import { BuildService, configFromEnv, confirmPhrase, createServer } from '@snjsm/mcp-server';

const xml = readFileSync(join(__dirname, '../../collector/test/fixtures/enterprise-update-set.xml'), 'utf8');
const base = analyse(snapshotFromXml([{ name: 'enterprise.xml', xml }]), { customer: 'Fixture Co', now: '2026-01-01T00:00:00Z' }).blueprint;
const signed = (bp: Blueprint): Blueprint => ({ ...bp, decisions: [...bp.decisions, { id: 'd.sign-off', at: '2026-01-02T00:00:00Z', by: 'vish', subject: { kind: 'blueprint', id: bp.id }, action: 'sign-off' }] });

function setup(o: { bp?: Blueprint; writeSites?: string[]; allowUnsigned?: boolean } = {}) {
  const workdir = mkdtempSync(join(tmpdir(), 'snjsm-mcp-'));
  mkdirSync(join(workdir, 'fx'));
  writeFileSync(join(workdir, 'fx/blueprint.json'), JSON.stringify(o.bp ?? signed(base)));
  const site = new FakeSite();
  const svc = new BuildService({
    workdir, writeSites: o.writeSites ?? [site.siteUrl], allowUnsigned: o.allowUnsigned ?? false, by: 'tester', defaultSite: site.siteUrl,
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
  it('refuses paths outside the work directory', () => {
    const { svc } = setup();
    expect(() => svc.loadBlueprint('../../etc/passwd')).toThrow(/outside the work directory/);
    expect(() => svc.loadBlueprint('/etc/passwd')).toThrow(/outside the work directory/);
    expect(() => svc.loadBlueprint('nope.json')).toThrow(/not found/);
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

    const st = svc.status({ blueprint });
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

  it('sets the target space, records the decision and makes the sign-off stale', async () => {
    const { svc, blueprint, site } = setup();
    expect(svc.summary({ blueprint }).signedOff).toBe(true);
    expect(() => svc.setSpace({ blueprint, mode: 'existing' })).toThrow(/needs its key/);
    expect(() => svc.setSpace({ blueprint, mode: 'new', key: 'bad key' })).toThrow(/invalid space key/);
    const r = svc.setSpace({ blueprint, mode: 'existing', key: 'its' });
    expect(r).toMatchObject({ designId: 'sp.it-service-desk', after: { mode: 'existing', key: 'ITS' }, signedOff: false });
    expect(r.next).toMatch(/sign off again/);
    const s = svc.summary({ blueprint });
    expect(s.spaces).toEqual([{ designId: 'sp.it-service-desk', name: expect.any(String), mode: 'existing', key: 'ITS' }]);
    expect(svc.loadBlueprint(blueprint).decisions.at(-1)).toMatchObject({ action: 'change', subject: { kind: 'design-element', id: 'sp.it-service-desk' } });
    const d = await svc.plan({ blueprint, dryRun: true });
    expect(d.warnings.some((w) => /ITS was not found/.test(w))).toBe(true);
    await expect(svc.apply({ blueprint, planHash: d.planHash, confirm: confirmPhrase(d.planHash, site.siteUrl) })).rejects.toThrow(/not signed off/);
    expect(site.writes).toHaveLength(0);
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
    expect(tools.map((t) => t.name).sort()).toEqual(['acceptance_cleanup', 'acceptance_plan', 'acceptance_run', 'blueprint_set_space', 'blueprint_summary', 'build_apply', 'build_confirm_manual', 'build_manual_steps', 'build_plan', 'build_status', 'build_verify', 'build_work_breakdown']);
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
