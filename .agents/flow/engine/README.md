# @dorkos/flow

## Purpose

The typed core of the `/flow` engine — DorkOS's one PM-agnostic workflow from capture to done. This package holds the authoritative config schema and the **pure decision functions** the engine runs at each tick: how to rank and claim work, when to involve the human, which gates apply, how to recover an orphaned run, and what proof a change needs.

It is schema + policy only. It performs no tracker I/O, no git, and no network calls — all tracker reads/writes are confined to the `linear-adapter` skill, which normalizes a tracker into the `WorkItem` shape this package consumes. Keeping the engine's brain pure keeps it auditable and unit-testable.

> **Not to be confused with** the `.agents/flow/` harness bundle (the v1 marketplace _plugin_ package — commands / skills / hooks / templates) or a future flow _extension_ (the P5 promotion target). This package is the typed-core **library** both would import; it is not itself an extension. It currently has no runtime importers — that is expected for a promotion surface that ships ahead of its consumer. See [`contributing/extension-authoring.md` → Concepts & naming](../../contributing/extension-authoring.md#concepts--naming).

## Exports

Single `.` barrel (plus `./config-schema` for tooling that needs the raw schema). Grouped by spec section:

| Area             | Exports                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| Config           | `FlowConfigSchema` + sub-schemas, `FlowConfig`, `buildConfigJsonSchema`    |
| Tasks            | `TasksFileSchema`, `TaskSchema`, `normalizeSize`, `isPromotableToSubIssue` |
| Work model       | `WorkItem`, `WorkItemRelations`, `OwnershipClass`, `StateCategory`         |
| Calibration (§5) | `resolveInvolvement` — uncertainty-gated human involvement                 |
| Dispatch (§4)    | `selectDispatch`, `filterEligible`, `rankEligible`, `isClaimable`          |
| Gates (§5–6)     | `planApprovalRequired`, `tripsCircuitBreaker`, `evaluateAutoMerge`         |
| Comms (§5)       | `resolveCommsChannel`, `shouldRespondToComment`                            |
| Identity (§7)    | `classifyOwnership`, `resolveIdentityMode`                                 |
| Recovery (§12)   | `recoverOrphan` + the durable `FlowRun` record                             |
| Evidence (§13)   | `selectEvidence` — the proof-of-completion plan for VERIFY                 |

## Usage

```ts
import { selectDispatch, resolveInvolvement } from '@dorkos/flow';

// Rank the ready queue: eligibility filter + the 7-tier ladder. `config` is the
// resolved `{ dispatch, ownership, wipCap }` blocks; `opts` carries ownership
// resolution + live WIP counts.
const pickList = selectDispatch(items, config, opts);
const next = pickList[0]; // head = "work on this next"

// Decide whether one decision point needs the human (the calibration ladder).
const involvement = resolveInvolvement(decision, calibration);
if (involvement.blocks) {
  // → stop and ask; otherwise proceed silently or with an assumption trail
}
```

The config schema generates `.agents/flow/config.schema.json` via `buildConfigJsonSchema`; the runtime config lives at `.agents/flow/config.json`.

## See also

- [`.agents/flow/README.md`](../../.agents/flow/README.md) — the engine manual
- [`.agents/flow/SPEC.md`](../../.agents/flow/SPEC.md) — the contract (section numbers referenced above)
- [`contributing/flow-engine.md`](../../contributing/flow-engine.md) — internal dev guide
- The `linear-adapter` skill — the only place tracker I/O is allowed
