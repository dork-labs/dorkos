---
name: writing-adrs
description: Guides writing concise, effective Architecture Decision Records. Use when creating ADRs, extracting decisions from specs, or reviewing ADR quality.
---

# Writing Architecture Decision Records

## Overview

Architecture Decision Records (ADRs) capture significant technical decisions in a concise, standardized format. They answer "why did we do this?" for future developers and AI agents. DorkOS ADRs live in `decisions/` with a `manifest.json` index.

## When to Write an ADR

Write an ADR when a decision:

- **Chooses between alternatives** — "We picked X over Y because..."
- **Adopts a pattern or technology** — New library, architecture pattern, data model
- **Has lasting consequences** — Affects how future features are built
- **Would surprise a new team member** — Non-obvious choices that need explanation

## When NOT to Write an ADR

Skip ADRs for:

- **Trivial implementation details** — Variable naming, file placement within an established structure
- **Obvious choices** — Using TypeScript in a TypeScript project
- **Temporary decisions** — Workarounds that will be replaced soon
- **Single-feature scope** — Decisions that only affect one spec with no project-wide impact

## Writing Guidelines

### Context (2-5 sentences)

Focus on the **problem**, not the solution. What situation existed? What forces were at play?

- **Good**: "DorkOS runs as both a standalone web app and an Obsidian plugin. The Obsidian plugin cannot make HTTP requests to localhost, so the client needs a way to communicate with the server that works in both environments."
- **Bad**: "We needed an architecture." (Too vague)
- **Bad**: A full page of background. (Too long — that belongs in the spec)

### Decision (2-5 sentences)

State what was decided in **active voice**. Start with "We will..."

- **Good**: "We will use a Transport interface that abstracts the communication layer. HttpTransport handles standalone mode via REST/SSE. DirectTransport handles Obsidian mode via in-process function calls."
- **Bad**: "The transport pattern was implemented." (Passive, vague)

### Consequences

List concrete positives and negatives. Every decision has trade-offs — if you can't list a negative, think harder.

- **Positive**: Real benefits the project gains
- **Negative**: Real costs, complexity, or limitations introduced

## Decision Signals in Specs

When scanning specs for ADR candidates, look for:

| Signal                         | Example                                  |
| ------------------------------ | ---------------------------------------- |
| "We chose X over Y"            | Technology or library selection          |
| "The recommended approach"     | Pattern adoption after comparing options |
| "Trade-offs" section           | Explicit trade-off analysis              |
| "Architecture" or "Design"     | Structural decisions                     |
| "We will not" / "Out of scope" | Deliberate exclusions with rationale     |

## ADR Lifecycle

| Status       | Meaning                                                         |
| ------------ | --------------------------------------------------------------- |
| `proposed`   | Significant decision recorded, not yet committed                |
| `accepted`   | Active decision guiding implementation                          |
| `deprecated` | No longer relevant (project evolved past it)                    |
| `superseded` | Replaced by a newer ADR (link via `superseded-by`)              |
| `archived`   | Determined trivial or historical; moved to `decisions/archive/` |

There is no `draft` status: significance is judged **at extraction time**. `/adr:from-spec` applies the significance rubric when extracting — decisions meeting 2+ "When to Write" criteria are written as `proposed` (or `accepted` if the spec already shipped); the rest are never written as files.

### Partial supersession: the `amends` relation

When a new ADR reverses **part** of an older one, the older ADR **stays `accepted`**. There is no `superseded-in-part` status, and inventing one is not the answer: a status is an instruction about whether to rely on the document, and marking a mostly-live ADR terminal tells every future reader to stop reading something they still need.

So:

1. **Parent keeps `status: accepted` and `superseded-by: null`**, in the file and in `decisions/manifest.json`.
2. **Parent's Status section names exactly what is retired:** quote the clause, list any Consequences bullets that fall with it, then state what still governs. Follow the shape `260726-170125` uses.
3. **Child carries `amends: <parent-id>`** in its manifest entry and frontmatter (a list when it amends several parents, e.g. `260731-211050`), and says in its own Status section which clause it replaces. That field is the only machine-readable link, so it is not optional.

Reserve `status: superseded` + a `supersedes` link for a **whole** ADR being replaced (`0224` → `260726-193526`, `0070` → `260726-171347`). `adr-drift-check.mjs` enforces the split: a `supersedes` link must point at a `superseded` ADR, and an `amends` link must point at a live one — a violation means either the wrong relation or an unflipped status.

The flagship example is `260727-182651`, which `amends` `260713-143958`: the parent spent three weeks mislabeled `superseded` while 45+ source files cited it as governing (corrected 2026-08-06 — the episode that motivated this relation).

### Two gates: review and audit

**`/adr:review`** (triggered when a spec is implemented or the proposed backlog grows)

Moves proposed ADRs to their terminal state:

- **Accept** (proposed → accepted): Linked spec is implemented and decision is reflected in code
- **Deprecate** (proposed → deprecated): Codebase diverged from this decision, or context changed
- **Supersede** (proposed → superseded): A newer ADR replaced this one
- **Archive** (proposed → archived): Decision is now obvious from reading the code

**`/adr:audit`** (triggered by the SessionStart nag, or quarterly)

Re-verifies **accepted** ADRs against the current codebase — `accepted` is a claim about the
present, and nothing else re-checks it. Subagents verify each ADR's concrete claims in code;
outcomes stamp `lastVerified` in the manifest, add amendment notes, or flip statuses. ADR bodies
stay immutable throughout — history is corrected by new records and status metadata, never by
rewriting old prose. Signals come from `adr-staleness-scan.mjs` (stale citations, dead paths,
verification age).

**Acceptance criteria:** A proposed ADR is ready for acceptance when:

1. The linked spec has been implemented (status `implemented` in spec manifest)
2. The pattern/technology/convention described in the ADR is present in the codebase
3. The decision is still actively guiding development (not just historical)

### Extraction

ADRs are seeded by the `/flow:specify` stage (when the flow plugin is loaded) or by `/adr:from-spec` when a spec is validated. Extraction applies the significance rubric immediately — only decisions that clear it become ADR files.

## Common Pitfalls

- **Too long** — ADRs are not specs. Keep each section to 2-5 sentences.
- **Missing negative consequences** — Every decision has costs. Be honest.
- **Vague context** — "We needed a better solution" tells nothing. What was broken?
- **Solution in context** — Context describes the problem, not the answer.
- **No spec link** — If a spec drove this decision, always link it.

## File Conventions

- **Location**: `decisions/<id>-kebab-case-title.md`
- **IDs**: a coordination-free timestamp `YYMMDD-HHMMSS` for new ADRs (allocate via
  `.claude/scripts/id.ts`); the ~260 legacy ADRs keep their frozen 4-digit numbers,
  which sort before timestamp ids (spec #271)
- **Manifest**: `decisions/manifest.json` tracks all ADRs (no `nextNumber` counter)
- **Template**: `decisions/TEMPLATE.md` for the standard format
- **Relations**: `supersededBy`/`supersedes` (full replacement), `amends` (partial — id or list)
- **`lastVerified`**: manifest-only date stamped by `/adr:audit`; never lives in frontmatter, so
  audits don't churn ADR files
- **`affects`**: optional path globs naming the code a decision governs — backfilled by audits,
  encouraged on new ADRs
- **Integrity**: `adr-drift-check.mjs` (SessionStart, silent when clean) validates files ⇄ manifest,
  links, and relation contradictions; `adr-staleness-scan.mjs` (on demand) finds stale citations,
  dead paths, and builds the audit worklist
