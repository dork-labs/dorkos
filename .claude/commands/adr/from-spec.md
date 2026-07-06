---
description: Extract Architecture Decision Records from a completed spec
argument-hint: '<spec-slug>'
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(node:*), Bash(gh:*), Bash(git:*)
category: documentation
---

# Extract ADRs from Specification

**Spec Slug:** $ARGUMENTS

Extract the architecturally significant decisions from a spec into ADRs. Significance is judged **at creation time** — no ADR is ever created with `status: draft`, and there is no separate curation pass.

## Steps

### Step 1: Read the Specification

Read `specs/$ARGUMENTS/01-ideation.md` (exploration and research) and `specs/$ARGUMENTS/02-specification.md` (final decisions).

### Step 2: Check for Existing ADRs

Read `decisions/manifest.json` and list any existing ADRs that already reference this spec slug — don't create duplicates.

### Step 3: Identify Candidate Decisions

Scan the spec documents for decision signals: technology choices ("we chose X", "X instead of Y"), pattern adoption, trade-off resolutions, and rejected alternatives.

### Step 4: Score Each Candidate Against the Significance Rubric

| #   | Criterion                                  | How to Assess                                                                |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| 1   | **Chooses between alternatives**           | Does it describe selecting X over Y? Or just "we used X"?                    |
| 2   | **Project-wide impact**                    | Does this affect how future features are built, beyond the originating spec? |
| 3   | **Would surprise a new team member**       | Is this a non-obvious choice that needs explanation?                         |
| 4   | **Adopts a lasting pattern or technology** | New library, architecture pattern, data model with long-term consequences?   |

Score = number of criteria met (0-4).

- **Score >= 2** → write the ADR (Step 5)
- **Score <= 1** → do **not** write it; list it in the Step 6 summary with its score so the judgment is auditable

### Step 5: Write the Qualifying ADRs

First, allocate a **distinct** timestamp id per ADR. Run
`node --experimental-strip-types --disable-warning=ExperimentalWarning .claude/scripts/id.ts`
once per ADR; if two land in the same second, bump the later one to the next second so every id in the batch is unique (coordination-free `YYMMDD-HHMMSS` ids, no shared counter — spec #271).

Then for each qualifying decision:

1. Draft the ADR using the `decisions/TEMPLATE.md` format with its allocated `<id>`: Context from the spec's research/ideation sections, Decision from its design/recommendation sections, Consequences from its trade-off analysis.
2. Set the status by shipped-ness: **`accepted`** if the spec has already shipped (spec manifest status `implemented`/`completed`, or the implementing PR is merged — verify with `gh pr list --state merged --search "$ARGUMENTS"` or the spec's `04-implementation.md`); otherwise **`proposed`** (it will progress via `/adr:review` once implemented). Never `draft`.
3. Set `spec:` frontmatter to `$ARGUMENTS`, write the file at `decisions/<id>-<slug>.md`, and add a manifest entry to `decisions/manifest.json` keyed by `id` (there is no `nextNumber` counter).

### Step 6: Display Summary

Report three groups:

- **Created** — id, title, status (proposed/accepted), file path
- **Skipped (below significance threshold)** — title, score, which criteria it missed
- **Skipped (already covered)** — title and the existing ADR that covers it

## Example

```
/adr:from-spec cross-client-session-sync
```
