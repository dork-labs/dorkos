# Flow Engine (`/flow`)

The `/flow` engine is one unified, PM-agnostic workflow system spanning **capture
to done**. It collapses the legacy `/ideate`, `/spec:*`, `/pm`, and `/linear:*`
command sprawl into a single stage model, run two ways: manual stages you drive
from the terminal, and an autonomous loop seated on DorkOS Pulse.

Flow's canonical home is **not this repo**. It lives entirely in the external
marketplace plugin at `dork-labs/marketplace`, `plugins/flow/` (ADR-0297). dorkos
is a **consumer** that dogfoods the plugin; it no longer hosts flow's source. This
guide is the **internal** dev orientation for that consumer relationship plus a
map of the plugin's internals; the **user-facing** manual and contract ship inside
the plugin itself.

> **Read these first.** They are the source of truth (in the plugin repo) and this
> guide points at them, it does not duplicate them.
>
> - `plugins/flow/README.md` (in `dork-labs/marketplace`): the operator manual
>   (stages, modes, gates, the adapter, the server dependency). The longer
>   manual pages are `plugins/flow/docs/*.mdx`.
> - `plugins/flow/docs/SPEC.md`: the contract (stage model, the `PMClient` promotion
>   surface, the `FlowRun` record, the typed engine, the config schema).
> - [`specs/flow-plugin-extraction/02-specification.md`](../specs/flow-plugin-extraction/02-specification.md):
>   the extraction spec (why flow left dorkos and how dorkos consumes it).

## How dorkos consumes flow

dorkos uses `/flow` heavily for its own daily development, so it dogfoods the
external plugin. Install it from the DorkOS Marketplace at **project scope**
(the app's Marketplace page, or `dorkos marketplace install flow --project <repo>`).
It lands in `<repo>/.dork/plugins/flow/`, and Harness Sync projects it into
`.claude/commands/flow/` and `.claude/skills/flow__*` (ADR 260706-192819), so
`/flow:*` works in DorkOS sessions and in the bare `claude` CLI alike. Without the
plugin installed, `/flow:*` does not exist: there is no in-repo fallback.

For a one-off session against a local marketplace checkout (for example, to try
a change to the plugin before it is published), Claude Code's `--plugin-dir` still
works:

```bash
# <marketplace-checkout> is your local clone of dork-labs/marketplace.
claude --plugin-dir <marketplace-checkout>/plugins/flow
```

There is **nothing to build**: the engine ships as runnable TypeScript (see
below). Every flow command is namespaced under `/flow:` (`/flow:flow` is the
orchestrator; `/flow:capture`, `/flow:specify`, `/flow:execute`, and so on are
the stages). On skill-only runtimes (Codex, OpenCode and DorkOS's own runtime) the same commands
arrive as `flow-command-*` skills.

There is no `@dorkos/flow` workspace package in dorkos anymore, and no esbuild
build. If you find a stale reference to `packages/flow/` or `@dorkos/flow` in
dorkos, or engine code (skills, scripts, commands) under `.agents/flow/`, it is
drift from the pre-extraction layout and should be removed.

The one thing that does belong in `.agents/flow/` is this repo's flow settings
(flow 0.8 and later): `config.json` is the committed team policy and holds no
secrets, `.gitignore` is written by flow, and `config.local.json` (the tracker
account, the team and the model bindings) stays in the main checkout, ignored by
git. Keep them. The plugin's own `config/CONFIG.md` explains the split, and
`config-files.ts resolve` prints which files flow is reading.

## Where the pieces live (inside the plugin)

The whole engine is one self-contained plugin. Everything below is **in
`dork-labs/marketplace`, `plugins/flow/`**, not in dorkos:

| Concern                                 | Location (under `plugins/flow/`)                             |
| --------------------------------------- | ------------------------------------------------------------ |
| Manual / contract / charter docs        | `README.md`, `docs/SPEC.md`, `docs/CHARTER.md`, `docs/*.mdx` |
| Namespaced trigger commands             | `commands/*.md` (`flow.md` + stages)                         |
| Stage skills (gerund) + the adapter     | `skills/`                                                    |
| Templates (records/docs/pr.md)          | `templates/`                                                 |
| Adapters (the v1 `linear-adapter`)      | `adapters/`                                                  |
| **The runnable engine (oracles + zod)** | `scripts/*.ts`                                               |
| Engine tests                            | `engine-tests/*.test.ts`                                     |
| Plugin config + generated JSON schema   | `config/`                                                    |
| The Stop hook                           | `hooks/`                                                     |

The Pulse autonomous tick ships **in the plugin** as the `skills/flow-drain/`
skill carrying `cron` + `enabled: false`; it is inert in v1 and does not depend on
dorkos's server task system for manual dogfood (ADR-0299).

## The runnable engine (`plugins/flow/scripts/*.ts`)

The engine's decision logic is **pure, typed, table-driven TypeScript**: the v1
promotion surface a future P5 server lifts unchanged. Each module takes config +
inputs and returns a decision; the pure oracles perform no I/O.

It ships as **runnable `.ts`, not a compiled artifact** (ADR-0298). Stage skills
invoke an oracle directly:

```bash
node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT}/scripts/<oracle>.ts
```

(`tsx` is the fallback for Node older than 22.6.) The source **is** the shipped
runtime: there is no build step, and an adopter never compiles or installs
anything. The pure oracles import only types, so they strip to
zero-runtime-dependency `.ts`. The one zod touch (`validate-config`) stays
dependency-free in the shipped path by validating against the committed
`config.schema.json`; zod is retained only as a **dev** dependency for authoring
the schema and running the tests.

Load-bearing oracles include `dispatch.ts` (eligibility filter + ranking),
`calibration.ts` / `involvement.ts` (the calibration ladder), `gates.ts`
(gates + auto-merge recovery), `comms.ts` + `comment-response.ts` (the
human-contact channel), `identity.ts` (the one ownership primitive),
`flow-run.ts` + `flow-state.ts` (the durable run record + recovery), `recovery.ts`
(the recovery ladder), and `evidence.ts` (proof-of-completion for VERIFY). The
`work-item.ts` module defines the normalized tracker shape; `tasks-schema.ts`
covers `03-tasks.json` + sub-issue promotion.

### Working on the config schema

The Zod `FlowConfigSchema` (`scripts/config-schema.ts`) is authoritative;
`config.schema.json` is **generated** (never hand-edit it). After changing the
schema, regenerate it and verify the checked-in plugin config still parses, from
inside the plugin:

```bash
cd <marketplace-checkout>/plugins/flow
npm install                 # dev deps only (zod, tsx, vitest, ajv); the shipped runtime needs none
npm run generate:schema     # regenerates config.schema.json
npm test                    # the engine oracle suite
```

The schema mirrors the spec's load-bearing decisions (`planApproval: false`,
`subIssueThreshold: "xl"`, `perIssue: "fresh-session"`, `seat: "pulse"`); a
round-trip + default-resolution test pins them.

## The adapter seam (the v1 `PMClient`)

**All tracker I/O is confined to the `linear-adapter` skill** (`skills/` +
`adapters/`): the single audit surface, the v1 realization of the `PMClient` (a
prose verb contract, not code yet). Stage skills call it by naming a capability
verb and **never embed a tracker string**. This is enforced inside the plugin: a
grep guard finds zero `mcp__linear__*` / Composio strings outside the adapter, and
an adapter-doc-completeness test lives in the plugin's `engine-tests/`.

When you add or change a stage skill, keep it PM-agnostic: speak `WorkItem` +
verbs, let the adapter own the projection onto the tracker's labels and states.
A future P5 server build promotes this prose contract into the typed
`interface PMClient` documented in the plugin's `docs/SPEC.md`.

## Templates

The plugin owns the templates the stages produce (`plugins/flow/templates/`),
**loaded by skills, not projected** to any harness:

- `records/`: tracker work-item bodies by type (`idea` · `research` ·
  `hypothesis` · `task` · `project`), each carrying `## Validation criteria` +
  `## On Completion` (the engine reads them for DONE routing + project-pulse).
- `docs/`: the filesystem doc scaffolds (ideation · specification ·
  `03-tasks.json` · ADR).
- `pr.md`: the PR template the VERIFY stage fills at the review gate.

Keep every template PM-agnostic: name stages and the generic model, never a
tracker API or a tracker-specific state name.

## Autonomous mode & the server dependency

The autonomous loop is the plugin-shipped `skills/flow-drain/` skill, whose
`schedule:` block (hourly, `enabled: false`) makes it a scheduled task. One tick
carries one item to its review gate, in a fresh resumable session. **Autonomous
mode needs a running DorkOS server (or a scheduler you wire yourself) to fire its
schedules; manual mode (`/flow:flow`, `/flow:<stage>`, `/flow:flow auto`) does
not.** DorkOS discovers the schedules: every project that has flow set up (it
holds `.agents/flow/config.json`) gets its own copy of `flow-drain`, `flow-groom`,
`flow-triage` and `flow-retro` on that project's **Schedules** page, switched off,
and a person approves each one there. Nothing is switched on for you.

**Who arms the merge.** The plugin arms in three places, and each runs the same
pre-arm guard first (the plugin's `config/CONFIG.md`, "Before every arm"):

- **A person's `flow review --approve`.** With `gates.review.mergeOnApproval`
  (default `true`, and on in this repo's `.agents/flow/config.json`), approving
  at the review gate arms auto-merge. The command refuses when run from inside an
  agent (Claude Code, Codex, OpenCode or a DorkOS agent turn) or from a session
  that worked the item, so an agent cannot approve as you.
- **The reviewer agent (`flow review --approve --by reviewer-agent`).** It needs a
  clean review recorded at the head and, by default, Security's
  `security-reviewed` label on every PR first.
- **`flow pr --arm` and the drain's re-arm**, only with `drain.armAutoMerge`
  (default `false`).

The guard refuses when, among others, a required check failed, the PR's head is
not the commit that was reviewed or no full commit SHA was recorded (flow arms
nothing it cannot tie to the approved commit), the PR does not target the default
branch, or Security's label is missing or older than the head.
[ADR-0276](../decisions/0276-auto-merge-on-approval-recovery-ladder.md)'s
recovery ladder (`gates.ts`, `recovery.ts`) handles what happens after an arm.

In this repo, outside the plugin's own approve path, nobody arms a PR:
`scripts/open-pr.sh` turns on auto-merge when it opens one, and the required
`pr-gates` check holds the merge until Security signs off, whoever armed it.
Security's sign-off is a signed review marker or a passing cloud
`security-verdict`; a `security-reviewed` label alone is only a note. The
plugin's own guard, described above, still asks for the label, so in this repo
`pr-gates` is the gate that decides. QA's and
the designer's labels are notes, not gates. `arm.sh`, `arm-door.yml` and
merge-tail's arming are retired (DOR-5124). See
[CI Pipeline Guide → Merging](ci.md#merging-auto-merge-at-open-the-pr-side-gates-and-the-door).

## The backlog groom (`/flow:groom`)

`/flow:groom` is the whole-tracker corrective sweep: it audits every open issue
against the groom invariants, closes shipped/duplicate/junk work with
cited evidence (behind a human gate), reconciles projects with the repo's real
programme structure, applies the `agent/ready` gate honestly, and proves the
result with a before/after run of the dispatch oracle. `/flow:groom check` is
the read-only audit half. Run it when the dispatch queue starves (the hygiene
loop's starvation message now names it), after a large programme lands, or
before enabling autonomous mode.

The invariants are code, not prose: `plugins/flow/scripts/audit-backlog.ts` in
the plugin (the `GRM-*` invariants, same dependency-free harness contract as
`validate-adapter.ts`), with engine tests that seed one violation per invariant
and assert the verdict goes red. The Linear-specific mechanics (the
`getBacklogSnapshot()` verb, the Duplicate-state trap, the bulk-write traps)
live in the `linear-adapter` skill, where all tracker I/O belongs. A weekly
scheduled check-mode seat (`skills/flow-groom/`, Mondays at 09:00, `enabled: false`) ships beside
`flow-drain` for whenever autonomy is switched on.

The process was extracted from the 2026-08-03 tracker reorganization, which
took the eligible dispatch pool from 21 of 276 open issues to 160 — and found
that the pre-groom queue's top-ranked pick was work the spec itself says cannot
be automated. The lesson the groom encodes: a ready label nobody audits decays
into noise.

## Testing

The engine oracles are unit-tested in `plugins/flow/engine-tests/` (Vitest,
table-driven). Run the suite from inside the plugin:

```bash
cd <marketplace-checkout>/plugins/flow
npm install   # first time only
npm test
```

The most load-bearing suites are the calibration ladder, dispatch ranking +
eligibility, `classifyOwnership`, the recovery ladder, the auto-merge recovery
ladder, and the config-schema round-trip; see the plugin's `docs/SPEC.md` Testing
Strategy for the intent behind each. Adapter behavior is tested at the
prose-contract level (doc-completeness) since the verbs are not yet code.
