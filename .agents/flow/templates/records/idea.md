<!--
  /flow record template — TYPE: idea
  The body the CAPTURE / TRIAGE stages write into a tracker work item of
  `type: idea`. PM-agnostic: it names stages and the generic WorkItem model,
  never a tracker API or a tracker-specific state name — the linear-adapter
  projects this onto the configured tracker. Generalizes the legacy
  linear-loop/templates/triage-idea + triage-intake bodies.

  Substitute the {placeholders}; keep the `## Validation criteria` and
  `## On Completion` sections — the engine reads them (DONE routing,
  project-pulse continuity). Provenance comments are appended by the adapter,
  not authored here.
-->

# {Idea title — concise, imperative}

**Type:** idea · **Origin:** {human | agent}

## Summary

{One or two sentences: the thought, captured cleanly. CAPTURE does not evaluate;
TRIAGE classifies and routes. Preserve the operator's words — do not paraphrase
away concrete constraints, numbers, or examples.}

## Context

{Where this came from and why it matters. If captured from a file, name the
source path. Link any related work item by identifier (ID-only back-links).}

## Validation criteria

{How we will know this idea was worth acting on — the observable outcome that
makes it a success once it ships. For an idea this is provisional; TRIAGE
sharpens it when the idea is accepted and re-typed.}

## On Completion

> The DONE stage (`closing-work`) reads this to recommend the next action, and
> the project-pulse check uses it to keep the loop spinning. Tick what applies.

- [ ] **Triaged → routed** by the TRIAGE stage (`/flow:triage`): accept · reject ·
      needs-research · needs-refinement.
- [ ] If **simple** (single-session, clear scope) → re-typed to a `task` that
      flows toward EXECUTE.
- [ ] If **complex** (3+ files, new pattern, cross-cutting) → escalated to IDEATE
      (`/flow:ideate`) → SPECIFY.
- [ ] If **uncertain** → spun off as a linked `research` item.
