# ServiceNow → Atlassian: outcome-driven assessment & build toolkit

Analyses a customer's ServiceNow instance (live via OAuth, XML exports, screenshots, process documents), works out
**what business outcomes it delivers**, and designs and builds the **Atlassian-native** way to deliver the same
outcomes in Jira Service Management, Jira, Confluence and Assets. SEs, partners and customers can all use it.

> **Principles:** outcomes first · Atlassian reference models by default · ServiceNow is evidence only ·
> extensions must be justified · success = outcome parity proven by acceptance tests. See [AGENTS.md](AGENTS.md).

```
Evidence (ServiceNow) → Outcome (platform-neutral, signed off) → Design (Atlassian) → Build → Verify
```

## Packages

| Package | Purpose | Status |
| --- | --- | --- |
| `packages/model` | Shared contracts (zod): Evidence, Outcome, Capability, Design elements (JSM + Assets), Coverage matrix, Blueprint; validators and dependency ordering; JSON Schema export | ✅ Phase 0 |
| `packages/reference` | Versioned Atlassian reference library, capability catalogue and API coverage matrix (data + validation) | ✅ Seeded (ITSM, Request hardware) |
| `packages/collector` | Read-only ServiceNow discovery: XML/update-set parser, OAuth client-credentials, Table API keyset paging, Aggregate API counts, Snapshot (XML or live: records + server-side aggregates; CMDB metadata and counts only) | ✅ Built; live run pending OAuth fix |
| `packages/analyser` | Snapshot → evidence (all domains, script static analysis, duplicates) → 15 area assessments incl. CMDB → Assets rationalisation → practice & capability detection → parameter resolution → outcomes + acceptance tests → configured reference design → fit/gap, buildability, complexity score → Blueprint + Markdown report | ✅ Built; needs a real estate to tune |
| `packages/tools` | Reference capture / compare against a real site, API coverage spike | ✅ Built; needs a valid Atlassian token |
| `packages/builder`, `packages/mcp-server` | Declarative build engine (plan / dry-run / apply / verify) exposed to Rovo CLI | ⏳ Phase 1 |
| `apps/workbench` | Forge app (Jira global page): capabilities, outcome sign-off, design, build, report | ⏳ Phase 3 |

## Reference library rules

- Every artifact has `verification.status`. Seeded entries are **unverified** until captured from a real site.
- Catalogue designs only contain `reference` / `reference-configured` elements. Customer `extension`s are added
  per blueprint, with a justification that links to evidence or outcomes.
- `npm run validate:reference` checks integrity: ids, dependencies, referenceIds, placeholders, outcome →
  design traceability. It also prints buildability per capability from the coverage matrix.

## Quick start

```bash
fnm use 22
npm install
npm run build              # tsc -b (project references)
npm test                   # vitest
npm run validate:reference
npm run schema:export      # writes packages/model/schema/*.schema.json
```

### Connect to ServiceNow (read-only)

1. Create a read-only integration user and an **OAuth – Client credentials grant** integration
   (Application Registry → New Inbound Integration Experience, opaque tokens, OAuth application user set).
2. Ensure `glide.oauth.inbound.client.credential.grant_type.enabled = true`.
3. Store credentials in the macOS Keychain, without echoing them:
   ```bash
   security add-generic-password -U -a atl_discovery -s sn-<instance>-client-id -T /usr/bin/security -w
   security add-generic-password -U -a atl_discovery -s sn-<instance>-client-secret -T /usr/bin/security -w
   ```
   On CI or in containers, set `SN_CLIENT_ID` / `SN_CLIENT_SECRET` instead.
4. `npm run sn:check -- <instance>.service-now.com`

### Run an assessment

```bash
# From XML exports / update sets (repeat --xml), from a live instance, or both
npm run analyse -- --xml export.xml --customer "Acme"
npm run analyse -- --instance <instance>.service-now.com --customer "Acme" --usage-days 365
# Optional: --site acme.atlassian.net --edition premium --capability itsm.request-hardware
#           --set itsm.request-hardware.costThreshold=1500 --max-evidence 5000 --out out/acme
```

Writes `out/<customer>/snapshot.json`, `blueprint.json`, `assessment.json` and `assessment.md` (gitignored).
Outcome parameters are resolved from evidence (approval conditions, fulfilment groups, item-level SLAs and
schedules). When there is no evidence, the catalogue default is used and marked **low confidence** for the workshop.

## Data handling

Only code, synthetic fixtures and reference data belong in this repo. `.gitignore` blocks credentials, snapshots,
blueprints, exports and reports. The collector is read-only (GET requests only, plus the OAuth token request) and
collects metadata and aggregate counts by default.
