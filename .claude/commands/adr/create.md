---
description: Create a new Architecture Decision Record
argument-hint: '<decision-title>'
allowed-tools: Read, Write, Edit, Grep, Glob, AskUserQuestion, Bash(node:*)
category: documentation
---

# Create Architecture Decision Record

**Decision Title:** $ARGUMENTS

---

## Steps

### Step 1: Allocate a timestamp id

ADRs use a coordination-free `YYMMDD-HHMMSS` id (no shared counter, so concurrent
branches never collide — spec #271). Get a fresh id:

```
node --experimental-strip-types --disable-warning=ExperimentalWarning .claude/scripts/id.ts
```

Use its output as `<id>`. If `decisions/<id>-*.md` somehow already exists (a rare
same-second clash), run it again for the next second.

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

Create the ADR file at `decisions/<id>-{slug}.md` where:

- `<id>` is the timestamp id from Step 1
- `{slug}` is a kebab-case version of the title

Use the template from `decisions/TEMPLATE.md`.

**Frontmatter fields:**

- `id`: The timestamp id from Step 1
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

Add a new entry to the `decisions` array in `decisions/manifest.json` with the
`id`, `slug`, `title`, `status`, and `created`. There is no `nextNumber` counter
to touch (removed in spec #271); the id is self-allocated.

### Step 6: Update Superseded ADR (if applicable)

If this ADR supersedes another:

1. Update the old ADR's frontmatter: `status: superseded`, `superseded-by: <id>`
2. Update the old ADR's Status section
3. Update the old entry in `decisions/manifest.json`

### Step 7: Display Summary

```
ADR Created
  ID:     <id>
  Title:  [title]
  File:   decisions/<id>-[slug].md
  Status: [status]
  Spec:   [slug or none]
```

## Example

```
/adr:create Use SSE for real-time streaming instead of WebSockets
```
