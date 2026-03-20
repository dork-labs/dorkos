---
description: Extract Architecture Decision Records from a completed spec
argument-hint: '<spec-slug>'
allowed-tools: Read, Write, Edit, Grep, Glob, AskUserQuestion, Task
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

For each selected decision:

1. Read `decisions/manifest.json` for the next number
2. Draft the ADR using the `decisions/TEMPLATE.md` format
3. Extract Context from the spec's research/ideation sections
4. Extract Decision from the spec's design/recommendation sections
5. Extract Consequences from the spec's trade-off analysis
6. Set `spec:` frontmatter to `$ARGUMENTS`
7. Write the ADR file
8. Update `decisions/manifest.json`

### Step 6: Display Summary

```
ADRs Extracted from spec: $ARGUMENTS

  Created:
    - 0006: [Title] → decisions/0006-[slug].md
    - 0007: [Title] → decisions/0007-[slug].md

  Skipped (already covered):
    - [Title] → covered by ADR 0003

  Total: N new ADRs created
```

## Example

```
/adr:from-spec cross-client-session-sync
```
