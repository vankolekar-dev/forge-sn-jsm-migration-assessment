import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotFromXml } from '@snjsm/collector';
import { analyse } from '@snjsm/analyser';
import { FakeSite, scopeElements } from '@snjsm/builder';
import { BuildService, MemoryStore, describeElement, elementsByCapability, signOffPhrase } from '@snjsm/workflow';

const xml = readFileSync(join(__dirname, '../../collector/test/fixtures/enterprise-update-set.xml'), 'utf8');
const base = analyse(snapshotFromXml([{ name: 'enterprise.xml', xml }]), { customer: 'Fixture Co', now: '2026-01-01T00:00:00Z' }).blueprint;

function setup() {
  const store = new MemoryStore();
  store.data.set('bp/blueprint.json', JSON.stringify(base));
  const site = new FakeSite();
  const svc = new BuildService({
    store, writeSites: [site.siteUrl], writeSitesHint: 'the sandbox setting', allowUnsigned: false, by: 'acc-123', defaultSite: site.siteUrl,
    clientFor: (_s, ro) => site.client(ro),
  });
  return { site, svc, blueprint: 'bp/blueprint.json' };
}

async function signAndBuild(svc: BuildService, blueprint: string) {
  const r = await svc.signOffReview({ blueprint });
  await svc.signOff({ blueprint, signHash: r.signHash, confirm: r.phrase! });
  const d = await svc.plan({ blueprint, dryRun: true });
  await svc.apply({ blueprint, planHash: d.planHash, confirm: d.phrase! });
}

describe('handoff briefs', () => {
  it('tells an agent where things stand and what the next gated step is', async () => {
    const { svc, blueprint, site } = setup();
    const before = await svc.handoff({ blueprint, audience: 'agent' });
    expect(before).toMatchObject({ audience: 'agent', signedOff: false, onSite: 0, site: site.siteUrl });
    expect(before.markdown).toContain(`\`${blueprint}\``);
    expect(before.markdown).toContain('`signoff_review`');
    expect(before.markdown).toContain(signOffPhrase('<signHash>', base.id));
    expect(before.markdown).toContain('proposed, not reviewed');
    expect(before.markdown).toContain('[mcp_servers.snjsm-builder]');

    await signAndBuild(svc, blueprint);
    const after = await svc.handoff({ blueprint, audience: 'agent' });
    expect(after.signedOff).toBe(true);
    expect(after.onSite).toBeGreaterThan(0);
    expect(after.guidedStepsPending).toBeGreaterThan(0);
    expect(after.markdown).not.toContain('Call `signoff_review`');
    expect(after.markdown).toContain('`build_manual_steps`');
  });

  it('gives Solution Composer one prompt per capability, foundation first, every in-scope element once', async () => {
    const { svc, blueprint } = setup();
    const r = await svc.handoff({ blueprint, audience: 'solution-composer' });
    const md = r.markdown;
    expect(md).toContain('**Not signed off yet:**');
    expect(md.indexOf('Foundation (do this first)')).toBeGreaterThan(-1);
    expect(md.indexOf('Foundation (do this first)')).toBeLessThan(md.indexOf('## 2.'));
    const scope = scopeElements(base);
    const bullets = md.split('\n').filter((l) => l.startsWith('- ') && /^- (Create|Use|Portal|Work type|Workflow|System field|Custom field|Form|Request type|Queue|Calendar|SLA|Team|Automation|Notification|Assets|Attribute)/.test(l));
    expect(bullets).toHaveLength(scope.length);
    expect(md).not.toMatch(/\.\.(\s|$)/);
    for (const o of base.outcomes.filter((x) => x.status === 'confirmed')) expect(md).toContain(o.statement);
    // The unreviewed build list is summarised, never turned into prompts.
    expect(md).toContain('**not reviewed**');
    expect(md).not.toContain('Business rule');
  });

  it('skips what is already on the site and says to reuse it', async () => {
    const { svc, blueprint } = setup();
    await signAndBuild(svc, blueprint);
    const md = (await svc.handoff({ blueprint, audience: 'solution-composer' })).markdown;
    expect(md).not.toContain('**Not signed off yet:**');
    expect(md).toMatch(/already exist; reuse them and do not create copies|Everything here is already on the site/);
  });

  it('groups every element exactly once and describes every type with names, not ids', () => {
    const scope = scopeElements(base);
    const groups = elementsByCapability(base, scope);
    expect([...groups.values()].flat().map((e) => e.id).sort()).toEqual(scope.map((e) => e.id).sort());
    expect([...groups.keys()][0]).toBe('');
    const names = new Map(base.design.map((e) => [e.id, e.name]));
    for (const e of base.design) {
      const line = describeElement(e, names);
      expect(line, e.id).toMatch(/\.$/);
      expect(line, e.id).toContain((e.spec as { name: string }).name);
      expect(line, e.id).not.toMatch(/\b(fld|wt|wf|rt|pg|cal|team|as\.ot)\.[a-z]/);
    }
  });
});
