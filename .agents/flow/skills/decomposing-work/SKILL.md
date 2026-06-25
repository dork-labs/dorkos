---
name: decomposing-work
description: The /flow engine's DECOMPOSE stage — break a validated specification into actionable tasks in 03-tasks.json, mirror the active phase into the tracker as a plan checklist, and project the stage/decompose label. Use when running /flow:decompose or advancing a work item into the DECOMPOSE stage.
---

# Decomposing Work — the DECOMPOSE stage

> **Stage:** DECOMPOSE (spec §1). One generic, PM-agnostic stage skill.
> **Absorbs:** today's `/spec:decompose` and `/spec:tasks-sync`.
> **PM projection (Linear):** `stage/decompose` label + the active-phase plan
> checklist mirrored into the work item.
> **Trigger doors:** the thin `/flow:decompose` command _or_ a PM transition into
> the DECOMPOSE stage are two triggers for this one skill.

This skill turns a frozen specification into the single source of truth for
implementation — `specs/<slug>/03-tasks.json` — and keeps the tracker in sync as
a _projection_ of it. The filesystem is canonical; the tracker holds pointers +
state + the plan checklist, never a second copy of the prose (spec §8).

## The one tracker rule

This is a generic stage skill. **It never touches a tracker API string.** Every
read or write to the tracker — the plan-checklist mirror, the `stage/decompose`
transition, any breadcrumb comment, sub-issue promotion — goes through the
**`linear-adapter`** skill by naming its capability verbs (`transition`,
`comment`, `createSubIssue`, `getRelations`). No raw tracker tool name, CLI
invocation, or slug lives here. (The `tracker-confinement` Vitest guard enforces
this for the whole flow bundle.)

## Process

### 1. Resolve the spec and slug

```
SPEC_FILE = the spec path from the trigger arguments
SLUG      = second path segment (e.g. "user-auth" from
            "specs/user-auth/02-specification.md")
TASKS_JSON = "specs/<SLUG>/03-tasks.json"
TASKS_MD   = "specs/<SLUG>/03-tasks.md"
```

Verify `SPEC_FILE` exists and is a valid specification (has the expected
sections). If it does not, stop and report — DECOMPOSE only runs on a frozen
spec (SPECIFY's output).

### 2. Detect mode (full · incremental · skip)

- **No `03-tasks.json`, or no matching tasks** in the built-in Task API for this
  slug → **full mode**.
- **`03-tasks.json` exists** → compare its `generatedAt` against the spec's
  changelog. New changelog entries → **incremental mode** (preserve DONE tasks,
  update affected pending tasks, create only new work). No new entries →
  **skip mode**: report "No changes since last decompose (<date>); delete
  `03-tasks.json` to force" and exit early.

### 3. Produce `03-tasks.json` + `03-tasks.md` (background agent)

Spawn a background `general-purpose` agent to do the heavy analysis off the main
context (saves ~90% of main context), writing **both** files to disk:

- `specs/<SLUG>/03-tasks.json` — machine-readable, the canonical schema below.
- `specs/<SLUG>/03-tasks.md` — human-readable breakdown for browsing + diffs.

The agent has **no** Task-API access; the main context creates tasks in step 4.

**Canonical `03-tasks.json` schema** (the existing schema, extended per spec §8):

```jsonc
{
  "spec": "<SPEC_PATH>",
  "slug": "<SLUG>",
  "generatedAt": "<ISO 8601>",
  "mode": "full | incremental",
  "lastDecomposeDate": "<DATE | null>",
  "tasks": [
    {
      "id": "1.1", // Phase.TaskNumber
      "phase": 1,
      "phaseName": "Foundation",
      "subject": "[<SLUG>] [P1] Imperative task title",
      "description": "FULL self-contained implementation detail",
      "activeForm": "Present-continuous spinner form",
      "size": "small | medium | large | xl",
      "priority": "high | medium | low",
      "dependencies": ["1.0"],
      "parallelWith": ["1.2", "1.3"],

      // Spec §8 schema extension — the ONLY place the task→issue map lives.
      // Populated only when a task is promoted to its own tracker sub-issue
      // (step 6). Absent otherwise; most tasks stay checklist-only.
      "issue": null,
      "parentIssue": null,
    },
  ],
}
```

**Content rule (critical):** descriptions are copied verbatim and self-contained
— full code blocks, technical requirements, and acceptance criteria with test
scenarios. The main context copies them into the Task API unchanged; there is no
second pass. Forbidden summarization phrases: "as specified", "from the spec",
"see specification", "as described above", "implement according to spec". If the
agent catches itself writing one, it stops and copies the real content.

### 4. Create tasks in the built-in Task API (main context)

This absorbs `/spec:tasks-sync`'s sync logic — it runs unconditionally as the tail
of decompose, and is also the manual repair path when JSON exists but the Task
API is empty.

1. Read `specs/<SLUG>/03-tasks.json`. If missing/malformed, fall back to parsing
   `03-tasks.md` (header pattern `^### Task (\d+)\.(\d+): (.+)$`, deriving
   `activeForm` from the imperative title), or re-run step 3.
2. List existing tasks for the slug (`TaskList()` filtered to `[<slug>]`); skip
   any already present (idempotent — safe to re-run).
3. For each missing task: `TaskCreate({ subject, description, activeForm })`,
   retrying once on failure. Track `task.id → created taskId`.
4. Resolve dependencies: for each task with `dependencies`,
   `TaskUpdate({ taskId, addBlockedBy: deps.map(id → createdId) })`. Skip deps
   whose task is absent.
5. Spot-check 2–3 created descriptions for the forbidden phrases; warn (don't
   block) if found.

The built-in Task API is a **live-display projection** of `03-tasks.json`, not a
parallel source of truth (spec §8 — collapse the dual task system).

### 5. Mirror the plan into the tracker (via `linear-adapter`)

Project the decomposition onto the work item — never authored independently:

- Via the adapter, `transition` the work item into the DECOMPOSE stage (sets the
  `stage/decompose` label).
- Mirror the **active phase** as a plan checklist on the work item, **generated
  from `03-tasks.json`, never hand-edited.** This is a projection: regenerate it
  from the canonical file rather than editing it in place.
- Optionally drop a breadcrumb `comment` (decomposed into N tasks; next stage is
  EXECUTE).

If no work item is linked (provenance block absent) or the tracker is
unavailable, skip the tracker mirror silently — decomposition on disk still
succeeds. Tracker integration is always optional.

### 6. Sub-issue promotion (the rare exception)

Promote a task to its own tracker sub-issue **only** when
`size ≥ decomposition.subIssueThreshold` (default `"xl"`); the parent's size does
not additionally gate (spec §8). The vast majority of tasks stay checklist lines.
When promotion fires: via the adapter, `createSubIssue(parent, spec)`, then write
the returned identifier into that task's `issue` field (and `parentIssue`) in
`03-tasks.json` — the canonical, normalized home of the task→issue mapping. A flat
top-level `issues: […]` list is rejected (it duplicates the map and reintroduces
drift).

### 7. Report

Report the spec path, mode, the two files written, the task counts by phase, the
parallel/critical-path summary, any promoted sub-issues (each as identifier with
title, `DOR-157 - Title`, per the linear-adapter display convention), and the next
stage: EXECUTE (`/flow:execute specs/<SLUG>/02-specification.md`).

## Calibration (spec §5)

DECOMPOSE is an **execution stage**: in the ambiguous middle (reversible +
not-confident), it **proceeds on the best default and logs the assumption**
(`agent/assumption` comment via the adapter + a note in the task) rather than
stopping to ask. The floor (row 0 — irreversible/outward-facing/secrets) still
stops and asks via the adapter's `needsInput`. The plan-approval gate after
DECOMPOSE is **off by default** (`gates.planApproval: false`); the engine flows
straight to EXECUTE and surfaces plan assumptions at the human-review gate.

## Guardrails

- Filesystem (`03-tasks.json`) is canonical; the tracker mirror is a projection.
- Never hand-edit the plan checklist; regenerate it from `03-tasks.json`.
- Keep descriptions self-contained — no summarization placeholders.
- All tracker I/O through `linear-adapter`. No tracker strings in this skill.
