# Flow Engine (`/flow`)

The `/flow` engine is one unified, PM-agnostic workflow system spanning **capture
→ done**. It collapses the legacy `/ideate`, `/spec:*`, `/pm`, and `/linear:*`
command sprawl into a single stage model, run two ways: manual stages you drive
from the terminal, and an autonomous loop seated on DorkOS Pulse. This guide is
the **internal** dev orientation; the **user-facing** manual and contract live in
the bundle itself.

> **Read these first.** They are the source of truth — this guide points at them,
> it does not duplicate them.
>
> - [`.agents/flow/README.md`](../.agents/flow/README.md) — the operator manual
>   (stages, modes, gates, the adapter, the server dependency).
> - [`.agents/flow/SPEC.md`](../.agents/flow/SPEC.md) — the contract (stage model,
>   the `PMClient` promotion surface, the `FlowRun` record, the typed engine, the
>   config schema).
> - [`specs/unified-workflow-system/02-specification.md`](../specs/unified-workflow-system/02-specification.md)
>   — the full spec (§ references throughout the bundle point here).

## Where the pieces live

The engine is deliberately **not** one place — it is a marketplace `plugin`-type
bundle plus a typed package. Honest layout:

| Concern                                   | Location                                                  |
| ----------------------------------------- | --------------------------------------------------------- |
| Bundle root (README/SPEC/config/manifest) | `.agents/flow/`                                           |
| Stage skills (gerund) + the adapter       | `.agents/flow/skills/` → symlinked into `.claude/skills/` |
| Templates (records/docs/pr.md)            | `.agents/flow/templates/` — loaded by skills              |
| Thin trigger commands                     | `.claude/commands/flow/` (Claude-native, not synced)      |
| The unified loop hook                     | `.claude/settings.json` (Claude-native)                   |
| Autonomous Pulse schedule                 | `.dork/tasks/flow-drain/SKILL.md` (project-scoped)        |
| **The typed engine**                      | `packages/flow/src/` (`@dorkos/flow`)                     |

The bundle's manifest (`.agents/flow/manifest.json`) lists every member; its
sync wiring is the `flow` entry in `.agents/harness.manifest.json` `skillBundles`.
**Skills are the only synced layer** — commands stay Claude-native (no repo-local
command format exists for Cursor/Codex) and the hook stays in `settings.json`.

## The typed engine (`packages/flow/src/`)

`@dorkos/flow` is the engine's decision logic as **pure, typed, table-driven
code** — the v1 promotion surface P5 lifts server-side unchanged. Each module
takes config + inputs and returns a decision; none performs I/O.

| Module                      | Export                                      | Decision                                       |
| --------------------------- | ------------------------------------------- | ---------------------------------------------- |
| `config-schema.ts`          | `FlowConfigSchema`, `FlowConfig`            | The authoritative Zod config + inferred type   |
| `generate-config-schema.ts` | `buildConfigJsonSchema`                     | `z.toJSONSchema` bridge → `config.schema.json` |
| `work-item.ts`              | `WorkItem` (+ sub-types)                    | The normalized tracker shape                   |
| `tasks-schema.ts`           | `TasksFileSchema`, `isPromotableToSubIssue` | `03-tasks.json` + `issue`/provenance           |
| `calibration.ts`            | `resolveInvolvement`                        | The 5-row calibration ladder (§5)              |
| `dispatch.ts`               | `selectDispatch`                            | Eligibility filter + 7-tier ranking (§4)       |
| `gates.ts`                  | `evaluateAutoMerge`, `tripsCircuitBreaker`  | Gates + auto-merge recovery (§5, §6)           |
| `comms.ts`                  | `resolveCommsChannel`                       | Infer the human-contact channel (§5)           |
| `comment-response.ts`       | `shouldRespondToComment`                    | Reading the comms channel back (§5)            |
| `identity.ts`               | `classifyOwnership`                         | The one ownership primitive (§7)               |
| `flow-run.ts`               | `recoverOrphan`, `FlowRun`                  | Durable run record + recovery ladder (§12)     |
| `evidence.ts`               | `selectEvidence`                            | Proof-of-completion plan for VERIFY (§13)      |

### Working on the config schema

The Zod `FlowConfigSchema` is authoritative; `config.schema.json` is **generated**
— never hand-edit it. After changing the schema, regenerate and verify the
checked-in `.agents/flow/config.json` still parses:

```bash
pnpm --filter @dorkos/flow build           # regenerates config.schema.json
pnpm --filter @dorkos/flow exec vitest run  # the engine unit suite
```

The schema mirrors the spec's load-bearing decisions (`planApproval: false`,
`subIssueThreshold: "xl"`, `perIssue: "fresh-session"`, `seat: "pulse"`); a
round-trip + default-resolution test pins them.

## The adapter seam (the v1 `PMClient`)

**All tracker I/O is confined to the `linear-adapter` skill** — the single audit
surface, the v1 realization of the `PMClient` (a prose verb contract, not code
yet). Stage skills call it by naming a capability verb and **never embed a tracker
string**. This is enforced: a grep guard finds zero `mcp__linear__*` / Composio
strings outside the adapter (see the `tracker-confinement` guard and the
adapter-doc-completeness test in `packages/flow/src/__tests__/`).

When you add or change a stage skill, keep it PM-agnostic — speak `WorkItem` +
verbs, let the adapter own the projection onto the tracker's labels and states.
The P5 server build (`Flow Engine — Extension`, DOR-88…) promotes this prose
contract into the typed `interface PMClient` documented in `SPEC.md`.

## Templates

The bundle owns the templates the stages produce
([`.agents/flow/templates/`](../.agents/flow/templates/README.md)) — **loaded by
skills, not projected** to any harness:

- `records/` — tracker work-item bodies by type (`idea` · `research` ·
  `hypothesis` · `task` · `project`), each carrying `## Validation criteria` +
  `## On Completion` (the engine reads them for DONE routing + project-pulse).
- `docs/` — the filesystem doc scaffolds (ideation · specification ·
  `03-tasks.json` · ADR).
- `pr.md` — the PR template the VERIFY stage fills at the review gate.

Keep every template PM-agnostic: name stages and the generic model, never a
tracker API or a tracker-specific state name.

## Autonomous mode & the server dependency

The autonomous loop is seated on **Pulse**: a project-scoped
`.dork/tasks/flow-drain/SKILL.md` croner schedule. One tick = one issue, in a
fresh resumable session. **Autonomous mode depends on a running DorkOS server
(Pulse) to host the chokidar watcher + croner; manual mode (`/flow`,
`/flow:<stage>`, `/flow auto`) does not.** This honest dependency statement ships
in the bundle README.

## Testing

The engine modules are unit-tested in `packages/flow/src/__tests__/` (Vitest,
table-driven). Run the suite with `pnpm --filter @dorkos/flow exec vitest run`.
The most load-bearing suites are the calibration ladder, dispatch ranking +
eligibility, `classifyOwnership`, the recovery ladder, the auto-merge recovery
ladder, and the config-schema round-trip — see the spec's Testing Strategy for
the intent behind each. Adapter behavior is tested at the prose-contract level
(doc-completeness) since the verbs are not yet code.
