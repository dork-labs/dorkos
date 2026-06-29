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
>   (stages, modes, gates, the adapter, the server dependency).
> - `plugins/flow/SPEC.md`: the contract (stage model, the `PMClient` promotion
>   surface, the `FlowRun` record, the typed engine, the config schema).
> - [`specs/flow-plugin-extraction/02-specification.md`](../specs/flow-plugin-extraction/02-specification.md):
>   the extraction spec (why flow left dorkos and how dorkos consumes it).

## How dorkos consumes flow

dorkos uses `/flow` heavily for its own daily development, so it dogfoods the
external plugin. The interim path (ADR-0299) is Claude Code's `--plugin-dir`:

```bash
# Clone dork-labs/marketplace first; <marketplace-checkout> is your local clone.
claude --plugin-dir <marketplace-checkout>/plugins/flow
```

This loads the plugin's commands, skills, and Stop hook into the session. There is
**nothing to build or install**: the engine ships as runnable TypeScript (see
below), so a local clone of the marketplace repo is all you need. Every flow
command is namespaced under `/flow:` (`/flow:flow` is the orchestrator;
`/flow:capture`, `/flow:specify`, `/flow:execute`, and so on are the stages).

The blessed dev loop (the documented `--plugin-dir` install, install provenance,
and a `dorkos contribute` round-trip) is tracked as DOR-172 (blocked by DOR-146 +
DOR-148). Until those land, `--plugin-dir` against a local checkout is the
sanctioned dogfood.

There is no `@dorkos/flow` workspace package in dorkos anymore, and no esbuild
build. If you find a stale reference to `packages/flow/`, `@dorkos/flow`, or
`.agents/flow/` in dorkos, it is drift from the pre-extraction layout and should
be removed.

## Where the pieces live (inside the plugin)

The whole engine is one self-contained plugin. Everything below is **in
`dork-labs/marketplace`, `plugins/flow/`**, not in dorkos:

| Concern                                 | Location (under `plugins/flow/`)     |
| --------------------------------------- | ------------------------------------ |
| Manual / contract / charter docs        | `README.md`, `SPEC.md`, `CHARTER.md` |
| Namespaced trigger commands             | `commands/*.md` (`flow.md` + stages) |
| Stage skills (gerund) + the adapter     | `skills/`                            |
| Templates (records/docs/pr.md)          | `templates/`                         |
| Adapters (the v1 `linear-adapter`)      | `adapters/`                          |
| **The runnable engine (oracles + zod)** | `scripts/*.ts`                       |
| Engine tests                            | `engine-tests/*.test.ts`             |
| Plugin config + generated JSON schema   | `config/`                            |
| The Stop hook                           | `hooks/`                             |

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
npm test                    # the engine oracle suite (414 tests)
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
`interface PMClient` documented in the plugin's `SPEC.md`.

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

The autonomous loop is seated on **Pulse**: the plugin-shipped
`skills/flow-drain/` skill with a croner schedule (`cron` + `enabled: false` in
v1). One tick = one issue, in a fresh resumable session. **Autonomous mode depends
on a running DorkOS server (Pulse) to host the chokidar watcher + croner; manual
mode (`/flow:flow`, `/flow:<stage>`, `/flow:flow auto`) does not.** This honest
dependency statement ships in the plugin README. Wiring the autonomous tick to
fire inside dorkos (the server task system discovering plugin-shipped tasks) is a
deferred follow-up, out of v1 scope.

## Testing

The engine oracles are unit-tested in `plugins/flow/engine-tests/` (Vitest,
table-driven; 414 tests). Run the suite from inside the plugin:

```bash
cd <marketplace-checkout>/plugins/flow
npm install   # first time only
npm test
```

The most load-bearing suites are the calibration ladder, dispatch ranking +
eligibility, `classifyOwnership`, the recovery ladder, the auto-merge recovery
ladder, and the config-schema round-trip; see the plugin's `SPEC.md` Testing
Strategy for the intent behind each. Adapter behavior is tested at the
prose-contract level (doc-completeness) since the verbs are not yet code.
