# Project instructions (for Rovo CLI and contributors)

This repo is a reusable toolkit that analyses a customer's ServiceNow instance and designs and builds the
**outcome-equivalent** solution on the Atlassian platform (JSM, Jira, Confluence, Assets).
SEs, partners and customers use it.

## Design principles (non-negotiable)

1. **Outcomes first.** The customer cares about the outcome, not how it was implemented. Analysis turns
   ServiceNow evidence into platform-neutral *outcomes* with testable acceptance criteria.
2. **Atlassian-native by default.** Every design starts from Atlassian's own reference models (JSM templates,
   work types, workflows, request types, SLAs, automation templates, Assets reference schemas, Teams).
   Never replicate ServiceNow structures.
3. **ServiceNow is evidence only.** ServiceNow artifacts justify scope, set parameters (thresholds, SLA goals)
   and back up extensions. They never define the target design.
4. **Extensions must be justified.** Any design element that is not in the reference model must have
   `origin: "extension"` with a justification that links to evidence or a confirmed outcome.
5. **Success = outcome parity**, proven by running acceptance criteria in a sandbox, not by configuration parity.

## Layers

`Evidence (ServiceNow) → Outcome (platform-neutral, signed off) → Design (Atlassian) → Build → Verify`

## Repo map

- `packages/model`: shared zod contracts (Evidence, Outcome, Design, Blueprint).
- `packages/reference`: Atlassian reference library, capability catalogue, API coverage matrix.
- `packages/collector` → `packages/analyser`: read-only ServiceNow discovery → evidence → outcomes → Blueprint.
- `packages/atlassian`: Atlassian Cloud REST client (retries, read-only mode, auth loaders).
- `packages/builder`: plan / dry-run / apply / verify engine and state file.
- `packages/acceptance`: acceptance-test planner and runner (test personas, tagged test data, cleanup ledger).
- `packages/workflow`: the build workflow and **all safety gates**, storage-agnostic (no `node:` imports).
- `packages/mcp-server`: stdio MCP server and `npm run jsm` CLI over the workflow, with a file store.
- `apps/workbench`: Forge app for Jira over the same workflow, with a Forge KVS store and a Custom UI.
- `packages/tools`: reference capture / compare and API coverage spike against a real site.
- `.rovo/skills/sn-jsm-outcome-migration`: the orchestrating Rovo skill. `packages/mcp-server/test/skill.test.ts`
  keeps it in step with the real tools, commands and gate phrases.

## Engineering rules

- Shared contracts live in `packages/model` (zod). Every package and tool reads and writes these types only.
- `packages/reference` is data plus validation. Each reference artifact records its verification status. Never
  mark something `verified` unless it was captured from a real Atlassian site. When a capture contradicts a seeded
  fact, mark the old artifact `deprecated`, add the verified one, and redesign the elements that relied on it, using
  template names and keeping extensions to a justified minimum.
- Write retries must never duplicate: only idempotent requests are retried on 5xx; an uncertain create is resolved
  by looking the element up again, never by re-sending it.
- Builds are declarative and idempotent (plan → dry-run → apply → verify). An LLM never calls Atlassian or
  ServiceNow APIs directly. It calls the deterministic tools exposed by the MCP server.
- Build safety gates live in `packages/workflow/src/service.ts`, never in prompts. The MCP server, CLI and Forge
  workbench all use them; don't copy gate logic into an adapter. Keep `packages/workflow` free of `node:` imports so
  it runs on Forge, and do file or KVS access through a `Store`. When orchestrating:
  1. Show the sign-off review, dry-run or acceptance plan to the person.
  2. Pass only a phrase the person typed, never one you composed:
     `SIGN OFF <signHash> FOR <blueprintId>` (`signoff_record`), `APPLY <planHash> TO <site>` (`build_apply`),
     `TEST <runHash> ON <site>` (`acceptance_run`), `CLEANUP <runId> ON <site>` (`acceptance_cleanup`).
  3. Call `build_confirm_manual` only after the person says they finished the guided step.
- When you add, rename or remove an MCP tool, CLI command or gate phrase, update the Rovo skill (`skill.test.ts`
  fails otherwise) and the README in the same change.
- ServiceNow access is read-only (dedicated integration user + OAuth). Collect metadata and aggregate counts,
  not records, unless the user explicitly opts in.
- Never commit secrets, customer snapshots, exports or reports. Test fixtures must be synthetic.
- Do not modify anything outside this repository.
