import type { Evidence, Provenance } from '@snjsm/model';
import type { SnRecord } from '@snjsm/collector';
import { analyseScript, intentOf, scriptRisk } from '../script';
import { isTrue, nameOf } from '../store';
import { domainOf, provenanceOf, type ExtractContext, type Extractor } from './common';
import { scriptRelations } from './process';

const host = (u: string | undefined) => {
  if (!u) return undefined;
  try { return new URL(u.replace(/\$\{[^}]+\}/g, 'x')).host || undefined; } catch { return u.match(/https?:\/\/([^/\s'"]+)/)?.[1]; }
};

/** Known product plugins → what they tell us about scope. Other plugins are only counted. */
const NOTABLE_PLUGINS: [RegExp, string, Evidence['domain']][] = [
  [/com\.snc\.change_management|change_management/, 'Change management', 'ITSM'],
  [/com\.snc\.problem/, 'Problem management', 'ITSM'],
  [/com\.snc\.sla|contract_sla/, 'Service level management', 'ITSM'],
  [/com\.glideapp\.servicecatalog|service_catalog/, 'Service catalog', 'ITSM'],
  [/com\.snc\.knowledge|knowledge_management/, 'Knowledge management', 'ITSM'],
  [/com\.glide\.service-portal|service_portal/, 'Service Portal', 'ITSM'],
  [/sn_esc|employee_center/, 'Employee Center', 'ITSM'],
  [/com\.glide\.cs\.|virtual_agent|com\.glide\.cs\b/, 'Virtual Agent', 'ITSM'],
  [/sn_hr|com\.sn_hr/, 'HR Service Delivery', 'HR'],
  [/sn_customerservice|com\.sn_customerservice/, 'Customer Service Management', 'CSM'],
  [/sn_wsd|facilities/, 'Workplace / Facilities', 'FACILITIES'],
  [/com\.snc\.discovery|discovery/, 'Discovery', 'ITOM'],
  [/service-mapping|service_mapping/, 'Service Mapping', 'ITOM'],
  [/com\.snc\.cmdb|cmdb_ci_class|csdm/, 'CMDB / CSDM', 'ITOM'],
  [/event_management|com\.glideapp\.itom\.snac|sn_em/, 'Event Management', 'ITOM'],
  [/sn_hamp|hardware_asset|com\.snc\.asset_management|alm/, 'Hardware asset management', 'ITAM'],
  [/sn_samp|software_asset|com\.snc\.software_asset/, 'Software asset management', 'ITAM'],
  [/sn_si|security_incident/, 'Security Incident Response', 'SECOPS'],
  [/sn_vul|vulnerability/, 'Vulnerability Response', 'SECOPS'],
  [/sn_grc|sn_risk|sn_compliance|policy_compliance/, 'Governance, risk & compliance', 'GRC'],
  [/com\.glide\.hub|integrationhub|sn_ih/, 'IntegrationHub', undefined],
  [/sn_itbm|ppm|com\.snc\.project/, 'Project portfolio management', 'ITBM'],
  [/sn_oncall|on_call/, 'On-call scheduling', 'ITSM'],
  [/major_incident|sn_mim/, 'Major incident management', 'ITSM'],
  [/predictive_intelligence|ml_|sn_pi/, 'Predictive Intelligence', undefined],
  [/performance_analytics|com\.snc\.pa/, 'Performance Analytics', undefined],
];

function aggregatedKnowledge(ctx: ExtractContext): Evidence[] {
  const s = ctx.store;
  const bases = s.table('kb_knowledge_base');
  const articles = s.table('kb_knowledge');
  const agg = s.aggregate('usage.kb-articles');
  const out: Evidence[] = [];
  const counts = (base: SnRecord | undefined, name: string) => {
    const keys = new Set([base?.sysId, name.toLowerCase()].filter(Boolean) as string[]);
    if (agg) {
      const rows = agg.rows.filter((r) => keys.has((r.group['kb_knowledge_base'] ?? '').toLowerCase()) || keys.has(r.group['kb_knowledge_base'] ?? ''));
      return { total: rows.reduce((n, r) => n + r.count, 0), published: rows.filter((r) => r.group['workflow_state'] === 'published').reduce((n, r) => n + r.count, 0) };
    }
    const mine = articles.filter((a) => (base && s.ref(a, 'kb_knowledge_base', ['kb_knowledge_base']) === base) || (!base && (s.display(a, 'kb_knowledge_base') || 'Knowledge') === name));
    return { total: mine.length, published: mine.filter((a) => a.fields['workflow_state'] === 'published').length, categories: [...new Set(mine.map((a) => s.display(a, 'kb_category')).filter(Boolean))], sample: mine.slice(0, 5) };
  };
  for (const b of bases) {
    const c = counts(b, nameOf(b));
    out.push({ id: `sn.kb_knowledge_base.${b.sysId}`.toLowerCase(), kind: 'knowledge-base', name: b.fields['title'] || nameOf(b), domain: 'ITSM', provenance: [provenanceOf(b, ctx)], usage: { active: isTrue(b.fields['active'] ?? 'true'), count: c.total }, attributes: { articles: c.total, published: c.published, owner: s.display(b, 'owner') ? 'set' : undefined }, relations: [], intent: 'Knowledge base', custom: undefined });
  }
  if (!bases.length && articles.length) {
    for (const name of [...new Set(articles.map((a) => s.display(a, 'kb_knowledge_base') || 'Knowledge'))]) {
      const c = counts(undefined, name);
      out.push({
        id: `sn.kb.${name}`.toLowerCase().replace(/[^a-z0-9._:-]/g, '-'), kind: 'knowledge-base', name, domain: 'ITSM',
        provenance: (c.sample ?? []).map((a) => provenanceOf(a, ctx)).slice(0, 5) as [Provenance, ...Provenance[]],
        usage: { count: c.total }, attributes: { articles: c.total, published: c.published, categories: c.categories, aggregated: true }, relations: [], intent: 'Knowledge articles (counted, not migrated)',
      });
    }
  }
  return out;
}

function portalEvidence(ctx: ExtractContext): Evidence[] {
  const s = ctx.store;
  const portals = s.table('sp_portal');
  const pages = s.table('sp_page');
  const widgets = s.table('sp_widget');
  const out: Evidence[] = [];
  const customWidgets = widgets.filter((w) => !/^widget-|^sp-/.test(w.fields['id'] ?? '') || /u_|x_/.test(w.fields['id'] ?? ''));
  for (const p of portals) out.push({ id: `sn.sp_portal.${p.sysId}`.toLowerCase(), kind: 'portal', name: p.fields['title'] || nameOf(p), provenance: [provenanceOf(p, ctx)], usage: { active: true }, attributes: { urlSuffix: p.fields['url_suffix'] || undefined, theme: s.display(p, 'theme') || undefined, pages: pages.length || undefined, widgets: widgets.length || undefined, customWidgets: customWidgets.length || undefined }, relations: [], intent: 'Self-service portal' });
  if (!portals.length && (pages.length || widgets.length)) {
    const first = pages[0] ?? widgets[0]!;
    out.push({ id: 'sn.portal.service-portal', kind: 'portal', name: 'Service Portal', provenance: [provenanceOf(first, ctx)], usage: {}, attributes: { pages: pages.length, pageNames: pages.map((x) => x.fields['title'] || x.fields['id']).filter(Boolean).slice(0, 20), widgets: widgets.length, customWidgets: customWidgets.length, aggregated: true }, relations: [], intent: 'Self-service portal (pages and widgets)' });
  }
  return out;
}

export const platformExtractors: Extractor[] = [
  { name: 'knowledge', tables: [], consumes: ['kb_knowledge', 'kb_knowledge_base', 'kb_category'], all: aggregatedKnowledge },
  { name: 'portal', tables: [], consumes: ['sp_portal', 'sp_page'], all: portalEvidence },
  {
    name: 'portal-widget', tables: ['sp_widget'],
    record: (r, c) => {
      const server = analyseScript(r.fields['script'], 'server');
      const client = analyseScript(r.fields['client_script'], 'client');
      const custom = !/^widget-|^sp-/.test(r.fields['id'] ?? '');
      if (!custom) return undefined;
      return { kind: 'portal-widget', intent: intentOf(server) ?? 'Custom portal widget', custom: true, attributes: { widgetId: r.fields['id'] || undefined, hasServerScript: Boolean(server) || undefined, hasClientScript: Boolean(client) || undefined, templateLines: (r.fields['template'] ?? '').split('\n').length, risk: scriptRisk(server), script: server, clientScript: client }, relations: [...scriptRelations(server, c), ...scriptRelations(client, c)] };
    },
  },
  {
    name: 'virtual-agent-topic', tables: ['sys_cs_topic'],
    record: (r) => ({ kind: 'virtual-agent-topic', intent: `Conversation: ${nameOf(r)}`, attributes: { intentType: r.fields['intent_type'] || undefined, setupComplete: isTrue(r.fields['setup_complete']) || undefined, category: r.fields['category'] || undefined, nlu: r.fields['nlu_model'] ? 'set' : undefined } }),
  },
  { name: 'report', tables: ['sys_report'], record: (r) => ({ kind: 'report', name: r.fields['title'] || nameOf(r), domain: domainOf(r.fields['table']), attributes: { table: r.fields['table'] || undefined, type: r.fields['type'] || undefined, filter: r.fields['filter'] || undefined, groupBy: r.fields['field'] || undefined } }) },
  { name: 'dashboard', tables: ['pa_dashboards'], record: (r) => ({ kind: 'dashboard', attributes: { tabs: r.fields['tabs'] || undefined } }) },
  { name: 'indicator', tables: ['pa_indicators'], record: (r) => ({ kind: 'report', attributes: { type: 'pa-indicator', indicatorType: r.fields['type'] || undefined, table: r.fields['facts_table'] || undefined, frequency: r.fields['frequency'] || undefined }, intent: `KPI: ${nameOf(r)}` }) },
  // Integrations
  {
    name: 'rest-message', tables: ['sys_rest_message'], consumes: ['sys_rest_message_fn'],
    record: (r, c) => {
      const fns = c.store.childrenOf('sys_rest_message_fn', 'rest_message', r);
      return { kind: 'integration', intent: `Outbound REST to ${host(r.fields['rest_endpoint']) ?? 'an external system'}`, attributes: { integrationType: 'rest-outbound', host: host(r.fields['rest_endpoint']), authentication: r.fields['authentication_type'] || undefined, methods: fns.map((f) => `${f.fields['http_method'] ?? ''} ${f.fields['name'] ?? ''}`.trim()), midServer: c.store.display(r, 'use_mid_server') || undefined } };
    },
  },
  {
    name: 'soap-message', tables: ['sys_soap_message'], consumes: ['sys_soap_message_function'],
    record: (r, c) => ({ kind: 'integration', intent: `Outbound SOAP to ${host(r.fields['wsdl'] || r.fields['endpoint']) ?? 'an external system'}`, attributes: { integrationType: 'soap-outbound', host: host(r.fields['wsdl'] || r.fields['endpoint']), functions: c.store.childrenOf('sys_soap_message_function', 'soap_message', r).length || undefined, authentication: r.fields['authentication_type'] || undefined } }),
  },
  {
    name: 'inbound-api', tables: ['sys_ws_definition'], consumes: ['sys_ws_operation'],
    record: (r, c) => {
      const ops = c.store.childrenOf('sys_ws_operation', 'web_service_definition', r);
      const scripts = ops.map((o) => analyseScript(o.fields['operation_script'], 'server')).filter(Boolean);
      return { kind: 'integration', intent: 'Inbound scripted REST API (other systems call ServiceNow)', attributes: { integrationType: 'rest-inbound', basePath: r.fields['base_uri'] || undefined, operations: ops.map((o) => `${o.fields['http_method'] ?? ''} ${o.fields['relative_path'] ?? o.fields['name'] ?? ''}`.trim()), scriptLines: scripts.reduce((n, a) => n + (a?.lines ?? 0), 0) || undefined } };
    },
  },
  { name: 'oauth-entity', tables: ['oauth_entity'], record: (r) => ({ kind: 'integration', intent: 'OAuth application / provider registration', attributes: { integrationType: 'oauth', type: r.fields['type'] || undefined, grantType: r.fields['default_grant_type'] || undefined } }) },
  { name: 'connection-alias', tables: ['sys_alias'], record: (r) => ({ kind: 'integration', intent: 'IntegrationHub connection / credential alias', attributes: { integrationType: 'alias', type: r.fields['type'] || undefined, connectionType: r.fields['connection_type'] || undefined } }) },
  { name: 'mid-server', tables: ['ecc_agent'], record: (r) => ({ kind: 'mid-server', intent: 'On-premises MID server (discovery / integrations behind the firewall)', attributes: { status: r.fields['status'] || undefined, version: r.fields['version'] || undefined, validated: r.fields['validated'] || undefined } }) },
  {
    name: 'scoped-app', tables: ['sys_app', 'sys_store_app', 'sys_scope'],
    record: (r) => {
      const scope = r.fields['scope'] || '';
      if (scope === 'global' || (!scope.startsWith('x_') && !scope.startsWith('sn_') && r.table === 'sys_scope')) return undefined;
      return { kind: 'scoped-app', custom: scope.startsWith('x_') || r.table === 'sys_app', domain: domainOf(scope), attributes: { scope, version: r.fields['version'] || undefined, vendor: r.fields['vendor'] || undefined, store: r.table === 'sys_store_app' || undefined } };
    },
  },
  {
    name: 'plugin', tables: ['sys_plugins'],
    record: (r) => {
      const id = `${r.fields['id'] ?? ''} ${r.fields['name'] ?? ''}`.toLowerCase();
      const hit = NOTABLE_PLUGINS.find(([re]) => re.test(id));
      if (!hit) return undefined;
      return { kind: 'plugin', name: `${hit[1]} (${r.fields['id'] || nameOf(r)})`, domain: hit[2], custom: false, attributes: { pluginId: r.fields['id'] || undefined, product: hit[1], version: r.fields['version'] || undefined } };
    },
  },
];
