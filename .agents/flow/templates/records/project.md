<!--
  /flow record template — TYPE: project
  The body the TRIAGE / SPECIFY stages write into a tracker PROJECT — the 1:1
  "home" for a large spec (spec §8 link cardinality: a small spec homes on one
  issue, a large spec homes on a project). PM-agnostic: the generic WorkItem
  project model (`{ id, name, stateCategory, lead }`), never a tracker API or a
  tracker-specific status name. Generalizes the project-creation path from the
  legacy linear-loop/templates/triage-intake (Brief → project) body.

  Creating a project is a FLOOR-level gate (spec §5): present the decomposition
  and ask before creating — never spin one up silently. Substitute the
  {placeholders}; keep `## Validation criteria` and `## On Completion`.
-->

# {Project name}

**Type:** project

## Goal

{What this project delivers and why it matters. One paragraph an operator can
read and immediately understand the bet. Apple Test: describe the outcome for
the user, not the internal mechanics.}

## Scope

- **In scope:** {the workstreams / deliverables this project owns}
- **Out of scope:** {what is explicitly excluded — prevents scope creep}

## Anchor & provenance

{The 1:1 anchor: this project is the tracker home for the spec at
`specs/<slug>/`. Filesystem is canonical (the spec/ADR/research prose lives on
disk); the project holds pointers + state + conversation, never a second copy.
Back-links are bidirectional but ID-only.}

## Validation criteria

{The project is a success when: {the goal's observable outcome}. This is the
project-level bar, distinct from any single child item's acceptance criteria.}

## On Completion

> The DONE stage (`closing-work`) runs a project-pulse check against this.

- [ ] All child work items reach a `completed`/`canceled` state category.
- [ ] No active spec remains linked in `specs/manifest.json` (do not close the
      project while one is in flight).
- [ ] All `monitor` items cleared → move the project to a `completed` state
      category.
