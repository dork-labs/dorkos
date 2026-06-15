---
name: ideating-features
description: Turns a feature brief, rough notes, or an existing partial design into a structured ideation artifact and next-step plan. Use when the user wants to explore a feature or shape rough requirements into a structured ideation artifact.
---

# Ideating Features

> **Stage: IDEATE in the `/flow` model.** This is the IDEATE stage skill of the
> unified `/flow` engine (spec §5.1, the stage spine: capture · triage ·
> **ideate** · specify · decompose · execute · verify · review · done). The
> `/flow:ideate` command and a PM `stage/ideate` transition are two triggers for
> this one skill; the next stage is SPECIFY (`specifying-work`). When the work is
> tracked, route any tracker I/O through the `linear-adapter` skill
> (`.agents/flow/skills/linear-adapter/SKILL.md`) — never a tracker call from
> here. The ideation document scaffold is externalized at
> `.agents/flow/templates/docs/ideation.md`; produce that shape.

## Overview

This is the shared-skill replacement for the legacy Claude Code `/ideate` workflow.

Use it to:

- turn a brief into a structured ideation document
- preserve and upgrade existing rough notes or partial design docs
- explore implementation options before specification work
- resolve key product and technical decisions before writing a spec

## Read First

Before acting, read:

- `AGENTS.md`
- `.claude/skills/orchestrating-parallel-work/SKILL.md` only if the user explicitly asks for parallel agent work

If the work is already tied to the spec system, also inspect:

- `specs/manifest.json`
- any existing `specs/<slug>/` materials referenced by the user

## Core Workflow

1. **Check for existing source material**
   - If the user gave a file path, rough notes, partial spec, or detailed design, read it first.
   - Preserve detail; do not paraphrase away concrete constraints, numbers, or examples.
2. **Classify maturity**
   - rough notes -> normal ideation
   - partial spec -> fast-track toward specification work
   - detailed spec -> adapt rather than re-ideate
3. **Create or identify the feature slug**
   - keep names URL-safe and consistent with `specs/`
4. **Capture intent and assumptions**
   - restate the brief
   - list explicit assumptions
   - define scope boundaries
5. **Do discovery**
   - inspect the relevant codebase areas
   - research only when needed
   - use parallel agent work only when the user explicitly asks for it
6. **Resolve key decisions**
   - ask bounded questions only for real ambiguities
   - present trade-offs when multiple approaches are meaningfully different
7. **Synthesize the ideation output**
   - preserve source fidelity
   - record decisions, risks, open questions, and recommended next step

## Output Expectations

Produce an ideation result that includes:

- feature intent
- source material references when applicable
- assumptions and out-of-scope boundaries
- relevant codebase findings
- decision trade-offs
- recommended direction
- next step: stay in ideation, move to specification, or adapt directly into spec work

## Cross-Agent Rules

- Treat this skill as the portable replacement for `/ideate`.
- Do not depend on slash-command chaining.
- Do not assume background-agent APIs exist.
- If no parallel agent support is available, do discovery sequentially and continue.
- If the user already provided a detailed design, preserve it and skip redundant ideation.
