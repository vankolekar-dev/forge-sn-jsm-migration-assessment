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
| `packages/builder` | Deterministic, declarative build engine: Blueprint design → plan / dry-run / apply / verify, a handler per element type (adopt template parts, create via API, guided steps for API gaps), state file, Jira work breakdown, in-memory fake site | ✅ Built; API contract unverified until write probes run in a sandbox |
| `packages/mcp-server` | stdio MCP server + `npm run jsm` CLI over the same service; all safety gates live here | ✅ Built |
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

### Build the design (JSM instance only, no data migration)

Each design element is either **adopted** (provided by the space template, bound after the space exists),
**created** through the public API, or turned into a **guided step** (where to go, the exact values, how to check)
when no API exists. The engine is additive and never deletes. Paths are relative to `SNJSM_WORKDIR` (default `out/`).

```bash
npm run jsm -- summary   --blueprint acme/blueprint.json
npm run jsm -- space     --blueprint acme/blueprint.json --mode existing --key ITS        # or --mode new [--name …] [--key …]
npm run jsm -- plan      --blueprint acme/blueprint.json                     # offline, nothing read
npm run jsm -- dry-run   --blueprint acme/blueprint.json --site acme-sandbox.atlassian.net   # read-only
SNJSM_WRITE_SITES=acme-sandbox.atlassian.net \
npm run jsm -- apply     --blueprint acme/blueprint.json --site acme-sandbox.atlassian.net --hash <planHash>
npm run jsm -- manual    --blueprint acme/blueprint.json --site acme-sandbox.atlassian.net   # guided steps
npm run jsm -- confirm   --blueprint acme/blueprint.json --site acme-sandbox.atlassian.net --id ref.reports-to --remote-id 42
npm run jsm -- verify    --blueprint acme/blueprint.json --site acme-sandbox.atlassian.net   # read-only
npm run jsm -- status | breakdown …                                          # state; one Jira epic per capability
```

Plans go to `out/plans/`, state to `out/state/<blueprintId>@<site>.json`, and run reports to `out/runs/`.

**Target space.** Each space in the design is either `new` (created from the template) or `existing` (built into
the space with that key; nothing is re-created). The dry-run checks the choice against the site:
- **New space:** if the wanted key is taken or reserved, the dry-run blocks it. If no key is given, it picks a free
  one from the name (e.g. `ISD` taken → `ISD2`).
- **Same-named space:** a new space never silently takes over a space with the same name. The dry-run blocks it
  until a person chooses.
- **Existing space:** it must exist and be the right space type. Template parts are matched in it, including
  `[System] …` names. Differences from the design are shown as guided steps.

Changing the target records a decision. Any earlier sign-off then lapses, so the blueprint must be signed off again.

**Safety gates.** apply runs only when every one of these holds:
1. The site is listed in `SNJSM_WRITE_SITES`. Empty means apply is disabled.
2. The blueprint was signed off after its last design change. Sandboxes can bypass this with `SNJSM_ALLOW_UNSIGNED=1`.
3. A dry-run with that plan hash was produced for that site.
4. A person typed exactly `APPLY <planHash> TO <site>`.
5. A fresh read-only dry-run still has the same hash.

Other protections: the state file is pinned to one blueprint and one site, locked while apply, confirm or verify
is running, and written after every step. Credentials come from `ATL_EMAIL` / `ATL_API_TOKEN`, or from the Keychain
items `atl-<site>-email` / `atl-<site>-api-token`.

### Use from Rovo CLI (MCP)

The tools are `blueprint_summary`, `build_plan`, `build_apply`, `build_manual_steps`, `build_confirm_manual`,
`build_verify`, `build_status` and `build_work_breakdown`. Only `build_apply` writes to a site, and only behind the
gates above. Run `npm run build` first, then register the server. For example, in `.mcp.json`:

```json
{
  "mcpServers": {
    "snjsm-builder": {
      "command": "node",
      "args": ["/path/to/repo/packages/mcp-server/dist/server.js"],
      "env": {
        "SNJSM_WORKDIR": "/path/to/repo/out",
        "SNJSM_SITE": "acme-sandbox.atlassian.net",
        "SNJSM_WRITE_SITES": "acme-sandbox.atlassian.net"
      }
    }
  }
}
```

## Data handling

Only code, synthetic fixtures and reference data belong in this repo. `.gitignore` blocks credentials, snapshots,
blueprints, exports and reports. The collector is read-only (GET requests only, plus the OAuth token request) and
collects metadata and aggregate counts by default.
