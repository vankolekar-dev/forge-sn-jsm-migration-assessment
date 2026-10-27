# ServiceNow → JSM workbench (Forge app for Jira)

A Jira app for the build half of the toolkit: upload a Migration Blueprint (from `npm run analyse`) or collect one
straight from ServiceNow over OAuth, review and sign off its outcomes, dry-run, apply behind the typed gate, work through guided steps and verify. It runs the same
workflow and gates as the CLI and the MCP server (`@snjsm/workflow`); only storage, identity and transport differ.

| Part | What it does |
|---|---|
| `src/workbench.ts` | Backend logic, independent of the Forge runtime: roles, payload validation, uploads, settings, jobs |
| `src/kv-store.ts` | `Store` on Forge KVS: key encoding, chunked values (240 KiB limit), version-swapped writes, atomic TTL locks |
| `src/transport.ts` | `AtlassianClient` through `requestJira`: this site's REST and Assets APIs only; anything else is refused at once |
| `src/forge.ts`, `src/index.ts` | Forge adapters (KVS, `asUser`/`asApp`, admin check, queue) and the resolver + queue consumer |
| `static/ui` | Custom UI (React + `@forge/bridge`): blueprints, overview, sign-off, build jobs, guided steps, acceptance plan, settings |

## Who can do what (checked on the server on every call)

- **Jira administrators**: everything: upload, choose spaces, start dry-run / verify / apply jobs, record guided steps, settings.
- **Signers** (account ids listed by an admin in Settings): read blueprints, reports and jobs; sign off outcomes.
- **Anyone else**: refused.

Identity is the Forge `accountId` and the site comes from the install context, so the browser cannot choose who or where.

## Gates

- **Sign-off**: `SIGN OFF <signHash> FOR <blueprintId>`, recorded under the signer's account. An uploaded blueprint
  never brings a sign-off with it: a sign-off made elsewhere stays in the history, but a recorded change makes it
  stale, so outcomes are signed off again in the workbench. Uploads with future-dated decisions are refused.
- **Sandbox designation**: builds only run after a Jira admin types `DESIGNATE <host> AS SANDBOX` in Settings.
  Removing the designation stops builds at once, including for dry-runs reviewed earlier.
- **Apply**: `APPLY <planHash> TO <site>` for a dry-run produced here. The phrase, the designation and the sign-off
  are checked when the job is queued and again when it runs; the engine repeats the dry-run and refuses if it changed.
- Phrases are typed (pasting is disabled in the dialog); the server decides, not the UI.

## ServiceNow components and JSM build & gaps

Two pages, for any blueprint (uploaded or collected), computed from the blueprint alone (no site reads):

- **ServiceNow components**: everything the analysis found, by category (CMDB classes and schema, groups and roles,
  flows and workflows, business rules, client scripts and UI policies, UI scripts, script includes and jobs, SLAs and
  schedules, assignment and approval rules, custom fields, catalog items, catalog variables, notifications, ACLs,
  portal and knowledge, reports, integrations, documents). Each item shows what it does, its table, usage, whether
  the customer built it and its script risk. Items load per category with search and paging; scripts are never sent.
- **JSM build & gaps**: every JSM element the blueprint designs (spaces and portal groups, request types, forms,
  custom fields, workflows and work types, queues, SLAs and calendars, automations, notifications, teams, Assets
  schemas, object types and attributes), each with its work (standard / configure / build custom), how the
  workbench builds it (automated / automated + guided steps / guided), the outcomes it delivers and the ServiceNow
  components it replaces. Below: the fit gaps per capability with their resolution, in-scope outcomes no element
  delivers, and fit to the Atlassian standard per capability. What already exists on the site is the Build tab's
  dry-run.
- **Build list for everything else in ServiceNow** (bottom of JSM build & gaps, labelled *proposed, not
  reviewed*): a first-pass JSM answer for every ServiceNow component that no capability, outcome, gap or design
  element covers yet, grouped by the JSM element it would become, with readiness from the API coverage matrix
  (buildable by API, guided, outside this builder, no JSM equivalent, not needed) and redesign flags for script
  logic. Inactive components are left out unless you include them. Nothing is built from this list: bring an item
  into a capability to build it. The same list is `npm run jsm -- build-list` for agents.

## Connect to ServiceNow (instead of uploading)

Jira admins can collect from a ServiceNow instance and analyse it in the app (tab **Connect to ServiceNow**). It is
read-only: the Table and Aggregate APIs plus the OAuth token endpoint, for configuration, catalog, workflow and CMDB
metadata and usage counts; CI records are not read. Egress is limited to `*.service-now.com` and
`*.servicenowservices.com` (backend only).

In ServiceNow: **System OAuth → Application Registry → New → Create an OAuth API endpoint for external clients**,
then note the client id and secret. Pick a grant:

- **Client credentials**: set the system property `glide.oauth.inbound.client.credential.grant_type.enabled` to
  `true` and give the registry entry an OAuth application user with read roles (e.g. `snc_read_only` plus read on
  the CMDB and catalog tables).
- **Password**: a dedicated integration user (web service access only) with the same read roles; enter its user name
  and password.

The client secret and password are kept in Forge encrypted secret storage, never returned to the browser, and must be
entered again if the instance, client id or user changes. **Test connection** checks the token, the instance version,
a Table API read and an Aggregate API count separately, so a missing role is obvious.

**Collect & analyse** runs as a chain of queue steps of up to 10 minutes each, checkpointing after every page and
count, so large instances work within the 900 s limit. Tables that are missing or unreadable are recorded as
warnings; anything that affects every request (network, rejected token, rate limits or 5xx after retries, an HTML
page from a hibernating developer instance) stops the collection at its last checkpoint instead, so a blueprint is
never silently incomplete; **Resume** continues from there. A collection with no progress for 20 minutes is marked
interrupted and can be resumed. The result is a blueprint like an upload: not signed off, and replacing an existing
one requires the replace option.

### Demo connection (basic auth)

For demos and developer instances, the tab **ServiceNow demo (basic auth)** connects with a ServiceNow user name and
password instead of OAuth. It is a separate connection (its own record, password in secret storage, collections),
so the OAuth connection for customer instances stays as it is. The same read-only collection and analysis apply.
**Sign in** passes on any answer but 401 (a 403 only means no read on that table).

At the bottom of the tab, **Logs** shows the last 250 ServiceNow requests (method, path, status, time, and the start
of ServiceNow's answer on failures) and workbench events (test checks, collection steps, warnings, the result),
newest first, with an errors-only filter. Headers and request bodies are never recorded, and tokens in error
answers are redacted. Logs are written at the end of a test, every 10 s during a collection step and when it ends.
The OAuth connection keeps a log too (resolver `snLogs`), not shown in its tab.

## Jobs

Dry-run, verify and apply run on a queue (`workbench-jobs`, 900 s limit), at most one at a time per blueprint. The
state is written after every step, so an interrupted apply resumes from the next dry-run. A retried event is never
re-run; a job with no result after 20 minutes is marked interrupted and frees the blueprint. Jobs act as the person
who started them (`asUser(accountId)`) or, if chosen in Settings, as the app.

Acceptance runs act as test personas with their own credentials, so they stay in the CLI / Rovo for now; the
workbench shows the acceptance plan.

## Deploy

```bash
eval "$(fnm env)"; fnm use 22       # Node 22 (Forge CLI supports 22 or 24)
forge login                        # once, with an Atlassian API token (you run this yourself)
cd apps/workbench
forge register                     # once: writes the real app.id into manifest.yml
npm run deploy                     # builds the engine packages and the UI, then forge deploy
forge install --site <site>.atlassian.net --product jira
```

Then, as a Jira admin: Apps → Manage apps → ServiceNow → JSM workbench (settings) to add signers and, on a sandbox
only, designate the site. The workbench itself is under Apps → ServiceNow → JSM workbench.

## To confirm on the first deploy (spike)

These depend on the platform and are not covered by the local tests (which use a fake site):

1. Assets through `requestJira` at `/jsm/assets/workspace/<id>/v1/...` with the `cmdb` scopes.
2. `asUser(accountId)` inside the queue consumer (otherwise switch Settings → Jobs act as → the app).
3. Project creation and request-type APIs as the user/app with `leadAccountId` set to the person who queued the job.
4. Egress to `*.service-now.com` with `redirect: 'manual'`, and KVS secret storage, from the resolver and the consumer.
5. Bundling the workspace packages (`@snjsm/*` → `packages/*/dist`) with `forge deploy`.
6. Real KVS behaviour: `FAIL_IF_EXISTS` lock conflicts, TTL expiry, and read/write time for a 2.4 MB blueprint.

Automation rules cannot be looked up from Forge (api.atlassian.com), so they stay guided steps in the workbench.

## Tests

`npm test` at the repo root runs `apps/workbench/test`: the KVS store against an in-memory KVS with Forge's key and
size rules, the transport, the backend end to end on the fake site (roles, uploads, forged sign-offs, designation,
gated apply, retries, interrupted jobs), and manifest/UI wiring.
