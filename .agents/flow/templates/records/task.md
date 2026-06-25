<!--
  /flow record template — TYPE: task
  The body the DECOMPOSE stage writes into a tracker work item of `type: task`
  (a single-session, self-contained unit of executable work). PM-agnostic:
  stages + the generic WorkItem model, never a tracker API or a tracker-specific
  state name. Most tasks stay checklist lines mirrored from `03-tasks.json` and
  are NEVER promoted to their own work item — promotion is the rare exception
  (`size ≥ subIssueThreshold`, default "xl", spec §8). Use this body only for a
  promoted sub-item.

  Substitute the {placeholders}; keep `## Validation criteria` and
  `## On Completion`. `03-tasks.json` is the single source of truth for
  decomposition; this body mirrors one promoted task — never hand-edit the
  checklist, regenerate it from the JSON.
-->

# {Task — actionable imperative, e.g. "Add error boundary to ChatPanel"}

**Type:** task · **Origin:** {human | agent} · **Size:** {xs | s | m | l | xl}

## What to do

{What to build or change, scoped to one agent session. Self-contained: enough
context to work without asking questions. Name the relevant file paths.}

## Context

{Why this task exists — the parent hypothesis/spec it advances (link by
identifier). Points back to `specs/<slug>/03-tasks.json` task `{id}` when this is
a promoted sub-item.}

## Validation criteria

{The acceptance criteria — the concrete, testable signal that this task is done.
"Done when: {tests pass / behavior X / no regressions in Y}." VERIFY checks
these and attaches proof-of-completion evidence.}

## On Completion

> The DONE stage (`closing-work`) reads this; the project-pulse check uses it to
> keep the loop spinning.

- [ ] Validation criteria met and proof attached (VERIFY stage).
- [ ] When done → check whether the parent hypothesis/spec has **all** its tasks
      complete; if so, route the parent toward closing.
- [ ] If this task was blocking others → note that they are now unblocked (the
      adapter reads the typed relation graph, not prose claims).
