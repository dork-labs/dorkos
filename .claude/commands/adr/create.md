---
description: Create a new Architecture Decision Record
argument-hint: '<decision-title>'
allowed-tools: Read, Write, Edit, Grep, Glob, AskUserQuestion
category: documentation
---

# Create Architecture Decision Record

**Decision Title:** $ARGUMENTS

---

## Steps

### Step 1: Read Current Manifest

Read `decisions/manifest.json` to get the next available number.

### Step 2: Gather Decision Context

If the title is vague or lacks context, use AskUserQuestion to clarify:

1. **What problem or situation motivated this decision?** (Context)
2. **What was decided?** (Decision — active voice: "We will...")
3. **What are the positive consequences?**
4. **What are the negative consequences or trade-offs?**
5. **Is this related to a spec?** (Optional — provide slug from `specs/manifest.json`)
6. **What is the status?** (Default: `accepted`)

If the user provides a detailed description, extract these from the description instead of asking.

### Step 3: Check for Related ADRs

Search `decisions/` for existing ADRs that might be related or superseded:

```
grep -l "[relevant keywords]" decisions/*.md
```

If a related ADR is found, ask the user if the new ADR supersedes it.

### Step 4: Write the ADR

Create the ADR file at `decisions/NNNN-{slug}.md` where:

- `NNNN` is the zero-padded number from manifest
- `{slug}` is a kebab-case version of the title

Use the template from `decisions/TEMPLATE.md`.

**Frontmatter fields:**

- `number`: From manifest
- `title`: Short imperative title
- `status`: `proposed` | `accepted` | `deprecated` | `superseded` (default: `accepted`)
- `created`: Today's date (YYYY-MM-DD)
- `spec`: Related spec slug or `null`
- `superseded-by`: `null` (unless superseding)

**Content guidelines (invoke `writing-adrs` skill):**

- Context: 2-5 sentences, problem-focused
- Decision: 2-5 sentences, active voice ("We will...")
- Consequences: Concrete positives and negatives

### Step 5: Update Manifest

Update `decisions/manifest.json`:

1. Increment `nextNumber`
2. Add new entry to `decisions` array

### Step 6: Update Superseded ADR (if applicable)

If this ADR supersedes another:

1. Update the old ADR's frontmatter: `status: superseded`, `superseded-by: NNNN`
2. Update the old ADR's Status section
3. Update the old entry in `decisions/manifest.json`

### Step 7: Display Summary

```
ADR Created
  Number: NNNN
  Title:  [title]
  File:   decisions/NNNN-[slug].md
  Status: [status]
  Spec:   [slug or none]
```

## Example

```
/adr:create Use SSE for real-time streaming instead of WebSockets
```
