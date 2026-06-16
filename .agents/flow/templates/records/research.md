<!--
  /flow record template — TYPE: research
  The body the TRIAGE / IDEATE stages write into a tracker work item of
  `type: research` (a question to investigate before committing to a build).
  PM-agnostic: stages + the generic WorkItem model, never a tracker API or a
  tracker-specific state name. Generalizes the legacy
  Linear-loop research templates (retired in spec #257).

  Substitute the {placeholders}; keep `## Validation criteria` and
  `## On Completion` — the engine reads them. Findings live on the filesystem
  (`research/YYYYMMDD_topic-slug.md`); the work item holds the pointer + state,
  never a second copy of the prose.
-->

# {Research question — phrased as a question}

**Type:** research · **Origin:** {human | agent}

## Question

{The specific thing to investigate. Bound it: a question that can be answered,
not an open-ended exploration. State what decision the answer unblocks.}

## Why now

{What this research feeds — the idea/hypothesis/spec waiting on the answer. Link
the dependent work item by identifier.}

## Approach

- {Sources to check first — start with `research/` (280+ existing reports) before
  doing new work.}
- {Codebase areas, prior decisions (`decisions/`), external docs to consult.}
- {What "enough" looks like — the depth the decision actually needs.}

## Validation criteria

{The question is answered when: a concrete recommendation exists, the trade-offs
are named, and the dependent decision can be made. The artifact is a
`research/YYYYMMDD_<topic>.md` report (filesystem is canonical).}

## On Completion

> The DONE stage (`closing-work`) reads this; the project-pulse check routes the
> findings onward.

- [ ] Write the findings to `research/YYYYMMDD_<topic>.md` and link it
      (ID-only back-link).
- [ ] If the answer is **clear and small** → create `task` sub-items that flow
      toward EXECUTE.
- [ ] If the answer **shapes a build** → escalate to IDEATE (`/flow:ideate`) →
      SPECIFY, carrying the findings forward.
- [ ] If the answer **needs validation** → create a `hypothesis` with the
      validation criteria below.
