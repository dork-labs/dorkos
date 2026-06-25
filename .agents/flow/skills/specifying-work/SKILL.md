---
name: specifying-work
description: The /flow engine's SPECIFY stage — turns a validated ideation artifact into an implementation-ready specification, resolves its open decisions, and seeds draft ADRs. Use when work is ready to move from IDEATE to a frozen spec. PM-agnostic; all tracker I/O routes through the linear-adapter skill.
---

# Specifying Work — the SPECIFY stage

> **Stage: SPECIFY in the `/flow` model.** This is the generic, PM-agnostic
> stage skill for SPECIFY (spec §5.1, the stage spine: capture · triage ·
> ideate · **specify** · decompose · execute · verify · review · done). A thin
> `/flow:specify` command and a PM `stage/specify` transition are two **triggers**
> for this one skill. It absorbs today's `/ideate-to-spec` + `/spec:create`.

Use it to:

- transform a validated `01-ideation.md` into an implementation-ready
  `02-specification.md`
- resolve the spec's open decisions interactively before the spec is frozen
- seed draft ADRs from the architectural decisions the spec surfaces

## The two rules of every `/flow` stage skill

1. **Never touch a tracker directly.** This skill contains no tracker MCP call,
   no CLI-fallback invocation, and no tracker slug. All tracker reads and writes
   (breadcrumb comments, stage transitions, evidence) route through the
   **`linear-adapter`** skill
   ([`../linear-adapter/SKILL.md`](../linear-adapter/SKILL.md)) by reference —
   e.g. "via the linear-adapter, `transition` the item to `stage/specify`". The
   adapter is the single audit surface for tracker I/O.
2. **Generic over PMs.** Branch only on the adapter's `WorkItem`
   `stateCategory`, never on a tracker's state display name. The skill works
   unchanged whether the tracker is Linear, Jira, or GitHub Issues.

## Doc scaffolds (externalized templates)

This skill carries **no inline document templates**. It references the
externalized scaffolds under [`../../templates/docs/`](../../templates/docs/),
filling the `{placeholders}` rather than copying a template into prose:

| Artifact                           | Template                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `specs/<slug>/02-specification.md` | [`templates/docs/specification.md`](../../templates/docs/specification.md)                                          |
| `specs/<slug>/03-tasks.json`       | [`templates/docs/tasks.json`](../../templates/docs/tasks.json) (DECOMPOSE seeds it; referenced here for provenance) |
| `decisions/NNNN-<slug>.md`         | [`templates/docs/adr.md`](../../templates/docs/adr.md)                                                              |

(The IDEATE input scaffold is [`templates/docs/ideation.md`](../../templates/docs/ideation.md),
owned by the `ideating-features` skill.)

## Read First

Before acting, read:

- `AGENTS.md`
- the input `specs/<slug>/01-ideation.md` (the SPECIFY input)
- `specs/manifest.json` and any existing `specs/<slug>/` materials
- relevant `decisions/` ADRs that may constrain the design

## Core Workflow

1. **Extract the slug & read the ideation artifact**
   - Input is `specs/<slug>/01-ideation.md`; extract `<slug>` for the output path.
   - Synthesize Intent & Assumptions, Codebase Map, Root Cause (if a bug),
     Research, and the resolved Decisions.
2. **Validate the problem from first principles**
   - Strip away solution assumptions; confirm the core problem is real and
     clearly defined. If it is not, stop and ask before specifying.
3. **Gather decisions interactively**
   - Walk the ideation's open clarifications. Present each with context, a
     recommended option, and trade-offs; record the resolution.
   - SPECIFY is an **intent stage**: when uncertain on a reversible call, **ask**
     rather than guess (spec §5 stage bias). One question per turn.
4. **Scope the specification**
   - One comprehensive spec vs. several smaller ones; prerequisites first;
     anything explicitly deferred. Map the end-to-end flow and blast radius.
5. **Write the specification**
   - Produce `specs/<slug>/02-specification.md` from the
     [`specification.md`](../../templates/docs/specification.md) scaffold. Fill
     every section meaningfully; carry ideation research forward verbatim where
     precision matters. No time/effort estimates.
6. **Resolve the spec's own open questions**
   - Extract any open questions the draft surfaces; resolve them interactively
     and record answers as struck-through `(RESOLVED)` entries with Answer +
     Rationale (preserving the original context as an audit trail). Re-read the
     file fresh on each pass so external edits and already-answered questions
     are respected.
7. **Seed draft ADRs**
   - Scan ideation + spec for decision signals (technology choices, pattern
     adoption, trade-off resolutions, rejected alternatives, deliberate
     exclusions — see the `writing-adrs` skill). For each, write a draft ADR
     from the [`adr.md`](../../templates/docs/adr.md) scaffold, numbered from
     `decisions/manifest.json` `nextNumber`, and add a manifest entry
     (`status: draft`, `extractedFrom: <slug>`). Skip if ADRs were already
     extracted for this slug.
8. **Update the manifest**
   - Ensure `specs/manifest.json` has an entry for `<slug>` at status
     `specified` (add if missing; promote from `ideation` if present).

## Tracker projection (via the adapter only)

When the work is tracked, project the stage through the **`linear-adapter`** —
never a tracker call from here:

- **On entry:** via the linear-adapter, `transition` the item to the
  `stage/specify` label (the adapter resolves the PM-side state category).
- **On completion:** via the linear-adapter, `comment` a breadcrumb on the item
  (spec created, location `specs/<slug>/02-specification.md`, next step
  DECOMPOSE). If the item is untracked or no adapter is available, skip silently
  — tracker projection is always optional.

## Output Expectations

- a complete, validated `specs/<slug>/02-specification.md` (all sections filled,
  open questions resolved)
- draft ADRs for the architectural decisions surfaced (or a note that they were
  already extracted)
- a synced `specs/manifest.json` entry at status `specified`
- recommended next step: **DECOMPOSE** (`/flow:decompose`)

## Cross-Agent Rules

- Treat this skill as the portable replacement for `/ideate-to-spec` + `/spec:create`.
- Do not depend on slash-command chaining; do the validation and ADR extraction inline.
- Do not assume background-agent APIs exist; do discovery sequentially if none are available.
- If the ideation already reads as a detailed design, adapt it into the
  specification scaffold rather than re-deriving it from scratch.
