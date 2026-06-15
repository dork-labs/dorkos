<!--
  /flow draft-ADR doc scaffold — `decisions/NNNN-<kebab-slug>.md`.
  Externalized from the legacy `/ideate-to-spec` auto-extract step so the
  SPECIFY stage skill (`specifying-work`) carries no inline ADR template.
  Task 4.x owns the full template set; this file is the canonical draft-ADR
  scaffold. One ADR per architectural decision surfaced during SPECIFY.

  `NNNN` comes from `decisions/manifest.json` `nextNumber`; increment it per
  ADR and add a manifest entry with `"status": "draft"` and
  `"extractedFrom": "<slug>"`.
-->

---

number: NNNN
title: { Title }
status: draft
created: { current-date }
spec: { slug }
superseded-by: null

---

# NNNN. {Title}

## Status

Draft (auto-extracted from spec: {slug})

## Context

{2–5 sentences from the spec's problem/research sections.}

## Decision

{2–5 sentences from the spec's design/recommendation sections.}

## Consequences

### Positive

- {From spec trade-off analysis}

### Negative

- {From spec trade-off analysis}
