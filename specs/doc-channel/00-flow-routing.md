# Flow routing for Doc Channel and its related tickets

## Current run authority and routing

The human explicitly assigned full Doc Channel delivery on 2026-10-01 and
authorized tracker writes, commits, pushes, independent reviews, PRs, normal
merge queue entry, verified merge, Flow DONE and safe owned-worktree cleanup.
Earlier read-only/push approval notes below are historical and superseded.
GPT-6.1 Sol/Medium is the explicit delegated model/effort. The coordinator allows
canonical shared ignored Flow metadata while source/docs/tests stay in worktrees.
This is direct issue routing, not an unrelated queue drain. Programme capacity
permits two implementation issues at once, fixes/browser first; Doc Channel
reconciles/reviews/decomposes before claiming its next available slot.

SPECIFY transition succeeded in this worktree. Current checkpoint and assumptions
are in 04-implementation.md and .dork/flow/HANDOFF.md. The source/consumer audit
identified shared admission, start/restart, rekey/close and writer handoff gaps;
the current specification resolves them pending independent review. Parent remains
open through all partial phases. No implementation claim has been made.

## Historical preparation record

Prepared 2026-10-01 from the installed `/flow` plugin and a fresh, team-scoped
snapshot produced by its configured Linear code adapter. The TRIAGE outcomes remain proposed. The operator has separately approved
reopening the existing canvas project; its execution receipt is recorded below.

## Engine and account checks

- `config-files.ts migrate`: already project-scoped; no migration needed.
- `config-files.ts`: valid config; shipped adapter is
  `.dork/plugins/flow/skills/linear-adapter/SKILL.md`; Flow is not paused.
- `flow snapshot --out /tmp/dorkos-doc-channel-flow-snapshot.json`: 251 open DOR
  items, fetched at 2026-10-01T18:57:07.452Z. Relations came through the adapter's
  team-scoped relation graph, not an issue API returning null relations.
- `flow status DOR-2665 --snapshot ... --json`: no run, parked question or drift
  for this item. Local spec artifacts do not create a claimed run.
- `flow autonomy --json`: project dial is missing. Effective decisions are person
  for sorting, questions and shipping. Do not infer unattended permission from
  committed `autonomy.default: auto` or `gates.planApproval: false`.
- CLI warns about an ignored top-level `//` setting. No secret warning or config
  error was returned. It does not prevent the reads/dry-runs below.

All subsequent Linear operations use a `flow` verb or the configured adapter.
Account/team/project values are resolved from project config and fresh tracker
reads. No ad hoc state/label writes, copied API recipes or workspace-wide issue
queries belong in the workflow.

## Current dispatch obstacles

DOR-2665 is `type/meta`, `stage/capture`, backlog, without `agent/ready`, and is
linked to project **Canvas and Browser in Rooms**
(`fd1a594d-4a1e-4a8f-8093-5466f78573b9`). That project is **completed**. The
project-scoped `flow next` oracle returns zero eligible/shapeable items. Readying
the issue alone would leave it excluded by project lifecycle policy.

DOR-2660–2664 and DOR-2666 are task-type backlog items at `stage/triage`, with no
project or readiness label. All seven lack native estimates in the normalized
snapshot. The five links from 2665 to 2660–2664 are related links; none is a typed
blocker. DOR-2666 relates to DOR-2060, not to the channel item in the graph.

The operator selected reopening the existing canvas project for this scoped
follow-on. Apply that approved lifecycle change through the configured adapter
and verify it before readiness.
Alternative: move the channel work to the existing **Maintenance** project
(`4bf1c533-58ec-4055-a5e1-cdee44f21f8b`, backlog). Never create a duplicate project
as a workaround. Existing **Relay, Mesh & A2A**
(`fe1e9a4b-0cfc-4080-8b21-9b5694d6de99`, unstarted) is the candidate home for relay
tickets, subject to exact-target confirmation.

## Proposed TRIAGE outcome

These are existing work items: use TRIAGE Path B, not CAPTURE or Brief intake.
Check duplication/shipped evidence against the full snapshot and code before
applying outcomes. Preserve unrelated labels and comments. Backfill native size
only once the scope is settled, never `0` for unknown.

| Item                                   | Recommended route                                                    | Reason and evidence required                                                                                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOR-2663 — sandbox served documents    | Accept → EXECUTE, canvas project                                     | Bounded existing serving seam. Require browser top-level isolation and normal frame rendering, not just a header assertion. Preserve required script functionality.                             |
| DOR-2660 — webhook namespace ownership | Accept → EXECUTE, Relay, Mesh & A2A                                  | Existing namespace validation/registration rules can enforce ownership. Include persisted invalid configs and boundary-aware routing; check scope before treating it as a simple task.          |
| DOR-2661 — signed JSON webhook parsing | Accept → EXECUTE, Relay, Mesh & A2A                                  | Implementation begins with a real full-app red regression using actual HMAC verification. Source inference is adequate to investigate, not to claim reproduced/fixed.                           |
| DOR-2662 — browser bridge provenance   | Accept → IDEATE, canvas project                                      | Proposed closure nonce does not solve same-page forgery. Resolve threat model and supported containment before freezing a fix. Then SPECIFY if the correction crosses layers.                   |
| DOR-2665 — Doc Channel                 | Accept → IDEATE entry, fast-track existing detailed design → SPECIFY | IDEATE's maturity rule says adapt detailed designs, do not re-ideate. Reconcile the prepared spec and its architectural recommendations, then DECOMPOSE. No channel implementation before that. |
| DOR-2664 — local sender authority      | Accept documentation scope → EXECUTE, Relay, Mesh & A2A              | Document current authority precisely. A process allowlist/new capability is a separate architectural decision; keep it in IDEATE if included, rather than silently expanding the docs task.     |
| DOR-2666 — relay acceptance receipts   | Accept → IDEATE, Relay, Mesh & A2A                                   | Decide status handle versus required replyTo versus documentation. HTTP compatibility and durable status ownership make this a design choice, not a small guessed fix.                          |

No unrelated queue drain or autonomous loop is needed. Scope each invocation to
these items; the wider team already has four claimed items, while the configured
global WIP cap is three. A manual scoped run must acknowledge that policy and
current ownership rather than silently claiming another issue through queue mode.

## Dependency policy

Keep independent fixes as independent tickets/PRs. Do not promote all six into
Doc Channel sub-issues or make every related issue a blocker.

- DOR-2663 blocks enabling v1 channels on served pages.
- DOR-2662's corrected bridge lifetime/provenance contract blocks v1 frame bridge
  rollout. It does not prevent isolated schema/store work.
- DOR-2660 must reserve the new doc principal before relay-based channel routing
  is exposed. Link the applicable delivery task once decomposition identifies it.
- DOR-2661 is an independent webhook defect, not a dependency of frame postMessage.
- DOR-2664 documentation and DOR-2666's broader HTTP contract remain related work;
  the channel must implement its own non-human identity and durable receipts.

Use the adapter's typed `link` operation. Initially record necessary coarse
blockers at 2665 only if phase tasks are not yet represented; refine them to
specific tasks after DECOMPOSE. Do not encode dependencies only in descriptions.

## Stage continuation

1. Project routing is resolved: the operator approved reopening the canvas project.
   The separate seven-item TRIAGE batch still needs exact-target approval under
   the inherited read-only handoff. Reopening a project does not ready its issues.
2. Apply TRIAGE via `flow triage <id> --ready --stage execute|ideate --json`.
   Type/priority/size/project/relations and provenance breadcrumbs go through the
   adapter, with fresh reads and read-back. No duplicate capture.
3. For 2665, use the current ideation plus detailed vault design as SPECIFY input.
   Enter via `flow stage DOR-2665 specify --checkpoint-file <body>`. Re-read the
   prepared specification and proposed ADRs, resolve actual operator decisions,
   and post the adapter breadcrumb. The local manifest is already `specified`;
   it describes an artifact, not a tracker transition or approved execution.
4. DECOMPOSE writes canonical `03-tasks.json` and readable `03-tasks.md` through
   the prescribed analysis worker. Mirror only the active phase, with explicit
   dependencies and full self-contained acceptance criteria. The task API is a
   display, not another source of truth. Where this harness has no task API,
   disclose that limitation and keep the JSON authoritative. Promote tasks to
   Linear sub-issues only at the configured native `xl` threshold.
5. EXECUTE starts isolation. Use the configured worktree tooling, claim the exact
   item with this real session ID, and record worker IDs/changes in
   `04-implementation.md`. Resolve delegated models from Flow's class/tier
   policy; unbound tiers use the harness default with an explicit run note.
   Do not run workers against this shared main checkout.
6. VERIFY requires fresh relevant tests, red→green bug proof, and independent
   adversarial review before a PR. Configuration requires one reviewer with
   `REVIEW.md`; current shipping authority is the person. Evidence follows UI/
   temporal/logic settings, not an arbitrary screenshot. The handoff's push/PR
   permission applies after a concrete verified diff exists.
7. Use non-closing `Refs DOR-2665` for a spec-only or partial-phase PR. Only the
   final complete scope may close the parent. VERIFY ends at REVIEW, never DONE.
   After merge/approval, DONE posts outcomes, creates justified follow-up work,
   checks the next loop action and safely tears down the owned worktree.

## Dry-run evidence

Verified through the actual CLI, without tracker mutation:

```text
flow stage DOR-2665 specify --dry-run --json
  ok:true, change:{stageLabel:"stage/specify"}, run:null

flow triage DOR-2663 --ready --stage execute --dry-run --json
  ok:true, change:{stateCategory:"unstarted",agentLabel:"agent/ready",
                  stageLabel:"stage/execute"}
```

The SPECIFY stage dry-run sets a stage label; it does not add readiness, claim
work, or reopen a completed project. This is why TRIAGE and project resolution
cannot be replaced by just running `flow stage` against the existing draft.

## Approved lifecycle change

The operator selected “Reopen Canvas and Browser in Rooms.” The configured
adapter account alias is `dorkos`, resolved from config.local.json; its viewer is
the existing Dork account and its team is DOR. An adapter-confined, team-scoped
read confirmed the exact project before the approved `projectUpdate` changed
`completed` to `started`. A second independent read confirmed `started` for
`fd1a594d-4a1e-4a8f-8093-5466f78573b9`. The vault guard was enabled for this one
approved mutation and restored to `read_only` in a finally block. No issue state,
label, relation, assignment or readiness was changed. The earlier handoff's
personal alias was used only for its initial prescribed reads; subsequent Flow
reads and this approved change use the project's configured alias.

## Plugin sources studied

README/manual; commands/flow.md, triage.md and specify.md; skills/linear-adapter,
triaging-work, ideating-features, specifying-work, decomposing-work,
executing-specs and verifying-work; templates/docs; config loader; work-state
projection; CLI triage/stage/checkpoint code; adapter contract/types and
linear-adapter/adapter.ts; provenance conventions. Repository ADR statuses take
precedence over the older template's draft-ADR wording: extracted ADRs are
proposed until implemented/reviewed.
