---
description: Extract Architecture Decision Records from a completed spec
argument-hint: '<spec-slug>'
allowed-tools: Read, Write, Edit, Grep, Glob, AskUserQuestion, Task, Bash(node:*)
category: documentation
---

# Extract ADRs from Specification

**Spec Slug:** $ARGUMENTS

---

## Steps

### Step 1: Read the Specification

Read both spec documents:

1. `specs/$ARGUMENTS/01-ideation.md` (exploration and research)
2. `specs/$ARGUMENTS/02-specification.md` (final decisions)

### Step 2: Check for Existing ADRs

Read `decisions/manifest.json` and check if any existing ADRs already reference this spec slug. List them so we don't create duplicates.

### Step 3: Identify Decisions

Scan the spec documents for decision signals:

- **Technology choices**: "We chose X", "Using X instead of Y", library selections
- **Pattern adoption**: Architectural patterns, design systems, data flow approaches
- **Trade-off resolutions**: "We decided to...", "The recommended approach is..."
- **Rejected alternatives**: "We considered X but...", "Option A vs Option B"

For each candidate decision, assess:

- Is it significant enough for an ADR? (Not trivial implementation details)
- Is it already covered by an existing ADR?
- Does it affect the project beyond this single feature?

### Step 4: Present Candidates

Present the identified decisions to the user for review:

```markdown
## Candidate ADRs from spec: $ARGUMENTS

| #   | Proposed Title | Signal                       | Already Covered? |
| --- | -------------- | ---------------------------- | ---------------- |
| 1   | [Title]        | [Quote or summary from spec] | No               |
| 2   | [Title]        | [Quote or summary from spec] | ADR 0003         |

Which decisions should become ADRs? (Enter numbers, e.g., "1, 3")
```

Use AskUserQuestion to get the user's selection.

### Step 5: Write Selected ADRs

First, allocate a **distinct** timestamp id per selected ADR. Run
`node --experimental-strip-types --disable-warning=ExperimentalWarning .claude/scripts/id.ts`
once per ADR; if two land in the same second, bump the later one to the next second
so every id in this batch is unique (coordination-free `YYMMDD-HHMMSS` ids, no shared
counter — spec #271).

Then for each selected decision:

1. Draft the ADR using the `decisions/TEMPLATE.md` format with its allocated `<id>`
2. Extract Context from the spec's research/ideation sections
3. Extract Decision from the spec's design/recommendation sections
4. Extract Consequences from the spec's trade-off analysis
5. Set `spec:` frontmatter to `$ARGUMENTS`
6. Write the ADR file at `decisions/<id>-<slug>.md`
7. Add a manifest entry to `decisions/manifest.json` with the `id` (there is no
   `nextNumber` counter to touch — removed in spec #271)

### Step 6: Display Summary

```
ADRs Extracted from spec: $ARGUMENTS

  Created:
    - 260703-081200: [Title] → decisions/260703-081200-[slug].md
    - 260703-081201: [Title] → decisions/260703-081201-[slug].md

  Skipped (already covered):
    - [Title] → covered by ADR 0003

  Total: N new ADRs created
```

## Example

```
/adr:from-spec cross-client-session-sync
```
