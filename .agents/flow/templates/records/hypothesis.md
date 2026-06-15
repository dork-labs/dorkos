<!--
  /flow record template — TYPE: hypothesis
  The body the TRIAGE / IDEATE / SPECIFY stages write into a tracker work item
  of `type: hypothesis` (a testable claim with explicit validation criteria and
  a confidence level). PM-agnostic: stages + the generic WorkItem model, never a
  tracker API or a tracker-specific state name. Generalizes the legacy
  Linear-loop planning templates (retired in spec #257).

  Substitute the {placeholders}; keep `## Validation criteria` and
  `## On Completion` — both are load-bearing. The DONE stage spins a `monitor`
  item that carries the validation criteria forward, so write them concretely.
-->

# {Hypothesis — a falsifiable claim}

**Type:** hypothesis · **Origin:** {human | agent} · **Confidence:** {low | medium | high}

## Claim

{We believe that {change} will produce {outcome} for {audience}. A hypothesis is
a bet — state it so it can be proven wrong.}

## Rationale

{Why we believe it — the evidence, prior research (link by identifier), or
decision that motivates the bet.}

## Validation criteria

{The observable, measurable signal that proves or disproves the claim. Be
concrete: a metric threshold, a user-visible behavior, a passing test. "We know
it worked when …". These criteria are copied into the `monitor` item at DONE, so
they must stand on their own.}

## Sizing & routing

- **Simple** (single file / one clearly-scoped component, < ~200 LOC, no new
  pattern, no cross-cutting concern) → decompose into `task` sub-items that flow
  toward EXECUTE; stay in the tracker, no spec workflow.
- **Complex** (3+ files across layers, new pattern, an architectural decision,
  cross-cutting, or multi-session) → escalate to the spec workflow: IDEATE
  (`/flow:ideate`) → SPECIFY → DECOMPOSE. When in doubt, prefer complex.

## On Completion

> The DONE stage (`closing-work`) reads this; the project-pulse check uses it to
> keep the loop spinning.

- [ ] When **validated** → create a `monitor` item carrying the
      `## Validation criteria` above, to track the outcome over time.
- [ ] When **invalidated** → record what was learned; route to a new idea or
      close the loop.
- [ ] When all child `task` items are done → check whether the hypothesis itself
      can be closed.
