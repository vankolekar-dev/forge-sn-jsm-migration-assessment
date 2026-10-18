---
name: sn-jsm-outcome-migration
description: >
  Orchestrate an outcome-driven ServiceNow → Jira Service Management migration with this repo's deterministic
  toolkit: analyse a ServiceNow snapshot into a signed-off Migration Blueprint, dry-run and apply the Atlassian-native
  build, walk the person through guided UI steps, verify, and prove outcome parity with acceptance tests in a sandbox.
  Use when someone asks to analyse ServiceNow, sign off outcomes, build or continue a JSM build, do guided steps,
  verify a build, or run acceptance tests for this toolkit (blueprints under out/, sites like *.atlassian.net).
---

# ServiceNow → JSM outcome-driven migration

You orchestrate. The toolkit decides and builds. Every write goes through the deterministic service in
`packages/mcp-server/src/service.ts`, and its safety gates live there, **not in this skill**. Your job is to:
- move the person through the stages
- show them what each step will do
- stop at every gate until **they** type the confirmation phrase

## Ground rules (do not bend these)

1. **Outcomes first.** The customer signs off outcomes and their given/when/then criteria. Success means those
   criteria pass in a sandbox, not configuration parity with ServiceNow. ServiceNow is evidence only.
2. **Never call Atlassian or ServiceNow APIs yourself to build, change or test.** That includes `curl`, TWG write
   commands and other MCP servers. Use only the tools below, or their CLI equivalents. Reading Confluence or Jira for
   context is fine.
3. **Never write a confirmation phrase for the person, and never pass one they did not type.**

   | Gate | Phrase the person types | Tool |
   |---|---|---|
   | Sign-off | `SIGN OFF <signHash> FOR <blueprintId>` | `signoff_record` |
   | Build | `APPLY <planHash> TO <site>` | `build_apply` |
   | Acceptance run | `TEST <runHash> ON <site>` | `acceptance_run` |
   | Test-data cleanup | `CLEANUP <runId> ON <site>` | `acceptance_cleanup` |

   - Show the phrase in a code block. Wait for the reply. Pass their text exactly.
   - If the reply is cut off or ambiguous, for example "defer approval an…", **ask; do not guess.** A sign-off records
     exactly what they approved.
   - A bare "APPLY" or "yes" is not the phrase. Show the full phrase again.
4. **Guided steps** are confirmed with `build_confirm_manual` only after the person says they did the step. Do one
   step at a time.
5. **Never put tokens or passwords in chat.**
   - Atlassian credentials come from the Keychain (`atl-<host>-email`, `atl-<host>-api-token`) or from `ATL_EMAIL` /
     `ATL_API_TOKEN`.
   - Personas use `atl-<host>-persona-<id>-email` / `-api-token`.
   - ServiceNow uses OAuth with a read-only integration user.
6. **Change nothing outside the repo.** Never commit `out/`, snapshots or customer data. Commit or push only when
   the person asks.

## Tools

Prefer the MCP server `snjsm-builder` (`packages/mcp-server`). If it is not registered, run the same service
through the CLI from the repo root: `npm run jsm -- <command> … --json`. The gates are identical either way.

| Stage | MCP tool | CLI fallback | Writes? |
|---|---|---|---|
| Orient | `blueprint_summary` | `npm run jsm -- summary` | no |
| Orient | `build_status` | `npm run jsm -- status` | no |
| Target | `blueprint_set_space` | `npm run jsm -- space` | local blueprint (sign-off lapses) |
| Sign-off | `signoff_review` | `npm run jsm -- review` | no |
| Sign-off | `signoff_record` | `npm run jsm -- sign-off` | local blueprint, gated |
| Build | `build_plan` (dryRun) | `npm run jsm -- dry-run` / `plan` | no (reads site) |
| Build | `build_apply` | `npm run jsm -- apply` | **site**, gated |
| Guided | `build_manual_steps` | `npm run jsm -- manual` | no |
| Guided | `build_confirm_manual` | `npm run jsm -- confirm` | local state only |
| Verify | `build_verify` | `npm run jsm -- verify` | no (reads site) |
| Plan work | `build_work_breakdown` | `npm run jsm -- breakdown` | no |
| Acceptance | `acceptance_plan` | `npm run jsm -- test-plan` | no |
| Acceptance | `acceptance_run` | `npm run jsm -- test` | **site** (tagged test data), gated |
| Acceptance | `acceptance_cleanup` | `npm run jsm -- test-cleanup` | **site** (only the run's tagged items), gated |
| Analyse | none (CLI only) | `npm run analyse` | local files |

**Paths.**
- Blueprint paths are relative to the work folder `out/`, for example `fixture/blueprint.json`.
- Plans, state, sign-off reviews, test plans and run reports are written under `out/`.
- Always tell the person which Markdown file to open.

**Environment.**
- The repo needs Node 22. `.node-version` pins it, so run `eval "$(fnm env)"; fnm use` before CLI calls.
- If `npm test` or the CLI fails with a vite or ESM start-up error, the shell is on the wrong Node.
- `SNJSM_WRITE_SITES=<host>` must name the site for any site write. Set it per command and do not export it.

## Stages

Start every session by orienting:
1. Run `blueprint_summary` and `build_status` for the blueprint and site.
2. Tell the person which stage they are at.
3. Offer the next step.

| Where things stand | Stage |
|---|---|
| No blueprint yet | 1 Analyse |
| Blueprint made with an older catalogue version (acceptance plan says "re-run the analysis") | 1 Analyse |
| Space choice not made, or wrong | 2 Target |
| Not signed off, or sign-off stale after a design change | 3 Sign-off |
| Signed off; no state on this site, or the plan has creates or updates | 4 Dry-run and apply |
| Guided steps pending | 5 Guided steps |
| Everything built or confirmed | 6 Verify |
| Verified | 7 Acceptance |

### 1. Analyse (CLI)

```bash
npm run analyse -- --snapshot out/<slug>/snapshot.json --customer "<Customer>" --out out/<slug>
npm run analyse -- --instance <instance>.service-now.com --customer "<Customer>"   # live, read-only OAuth
npm run analyse -- --xml export.xml --customer "<Customer>"
# options: --site <host> --edition premium --capability <id> --set <cap>.<param>=<value>
```

- **Output:** `snapshot.json`, `blueprint.json`, `assessment.json` and `assessment.md`. Summarise the assessment:
  - capabilities in scope
  - outcomes
  - parameters taken from ServiceNow evidence, such as thresholds and SLA goals
  - blockers
- **Back up first.** Before re-analysing over an existing blueprint, copy it to `blueprint.<date>.json`.
- **A re-analysis gives a new blueprint id, so a new state file.**
  - The dry-run links items it finds on the site ("adopt").
  - It **carries forward** guided steps that a person confirmed for an earlier blueprint on the same site, when the
    design is identical. They are listed under "Guided steps carried forward". Point these out.
  - Steps whose design changed must be confirmed again.

### 2. Target

Each space is `new`, made from the template, or `existing`, the space with that key.
- Ask the person. Then call `blueprint_set_space` with a short reason.
- This records a decision and makes any earlier sign-off lapse. Say so.

### 3. Sign-off

1. Call `signoff_review`. Show:
   - a table of outcomes: id, priority, statement, criteria count, automated or manual
   - the parameters
   - the capability versions
   - the review file `out/signoff/…md`
2. Explain that open outcomes are confirmed unless named:
   - `defer` or `reject` an outcome to leave it out of acceptance tests. Its design stays in the blueprint.
   - `reinstate` brings an outcome back.
   - Amending a signed-off blueprint is a new reviewed sign-off with the same phrase.
3. Check what an outcome change really means before suggesting one. Example: the manager persona is used by approval
   **and** service-level checks, so deferring only approval does not remove the persona. Use the acceptance plan's
   steps (`as:` actors) to check.
4. Show the phrase. When they type it, with any defer, reject or reinstate list, call `signoff_record`.

### 4. Dry-run and apply

1. Call `build_plan` with `dryRun: true` for the site. Show:
   - the summary: create, update, adopt, noop, manual, blocked
   - every **create** and **update**, with its reason
   - adopted items and their site ids, as a table
   - carried-forward confirmations
   - blocked items and warnings
   - the plan file
2. Point out anything surprising. For example, an item marked "differs from the design" on a reused template part
   is a design decision for the person, not something to work around.
3. If `writeAllowed` is false, explain that `SNJSM_WRITE_SITES` must name the site for this run.
4. Show `APPLY <planHash> TO <site>`. On the exact reply, call `build_apply`.
5. Report the results: done, manual, blocked, failed.
   - "Probably not created — run the dry-run again" means just that. Never retry a create by hand.
   - A hash mismatch means the site or design changed. Run the dry-run again and review it.

### 5. Guided steps

1. Call `build_manual_steps`. List the pending steps in build order, with what each one unblocks. Use the acceptance
   plan's blockers to prioritise.
2. Present **one** step: where to go, the exact values as a table, and the check. Adapt names to what is really on
   the site, for example a reused schema key, and say so.
3. Wait for "done". Then call `build_confirm_manual` with `designId`.
   - Add `remoteId` and `remoteKey` when the step records a site id.
   - Add a `note` for anything they did differently.
   - If they did it differently from the design, record the note and mention it at verify.
4. Move to the next step. If they skip ahead or stop, leave the step unconfirmed.

### 6. Verify

Call `build_verify`. Report ok, drift, missing, pending and unverifiable. Drift and missing items go back to stage 4
or 5. Never "fix" drift outside the toolkit.

### 7. Acceptance

1. Call `acceptance_plan`. Show:
   - ready, blocked, manual and excluded counts
   - each blocked criterion with its reasons, grouped by cause: guided step, persona credentials, drift, stale
     catalogue
   - the persona actors needed
2. **Persona logins:** a person's own token cannot approve for someone else, so personas must be separate test users.
   If credentials are missing, offer three options:
   - set up the persona (Keychain names above)
   - add only the account id, where that is enough
   - defer the outcomes that need it, through stage 3
3. Show `TEST <runHash> ON <site>`. On the exact reply, call `acceptance_run`.
4. Report pass and fail per criterion, with the evidence and the run report file. Test data is removed afterwards
   unless `keep` was set.
5. If anything was left behind, show `CLEANUP <runId> ON <site>` and call `acceptance_cleanup` on the reply.

### Optional: work breakdown

`build_work_breakdown` returns one epic per capability and one story per guided step.
- Create Jira items only when asked.
- Confirm the project first, then use the Jira tools and report the links.

## Reporting

- Keep each turn short: the stage, what changed, the files to open, and the next gate or choice.
- End with the sensible next options.
- When the person asks for progress notes, summarise by date: blueprint id, plan and run hashes, and what is blocked.
