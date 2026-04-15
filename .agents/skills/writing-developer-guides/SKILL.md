---
name: writing-developer-guides
description: Structures developer guides for optimal AI agent and human consumption. Use when creating or updating files in contributing/, or when documentation needs to support autonomous coding agents.
---

# Writing Developer Guides

## Overview

This skill teaches how to write developer guides that work well for both AI coding agents and human developers. The key insight: AI agents need fast context retrieval, clear decision support, and copy-paste ready patterns.

## When to Apply

- Creating a new file in `contributing/`
- Updating or refactoring an existing guide
- Reviewing guides for completeness
- User asks about documentation structure

## Core Principle

**Structure for retrieval, not teaching.**

Traditional documentation assumes sequential reading. AI agents retrieve specific information based on task context. Every section should be independently useful.

## Required Sections (In Order)

Each developer guide must include these sections in this sequence:

### 1. Title + Overview (2-3 sentences)

```markdown
# [Topic] Guide

## Overview

[What this guide covers] and [why it matters for this project].
```

**Why this order:** AI agents use the overview to determine relevance before reading further.

### 2. Key Files Table

```markdown
## Key Files

| Concept       | Location             |
| ------------- | -------------------- |
| Configuration | `src/path/config.ts` |
| Types         | `src/path/types.ts`  |
```

**Why early:** Agents need to know WHERE before HOW. This prevents searching.

### 3. Decision Matrix ("When to Use What")

```markdown
## When to Use What

| Scenario | Approach | Why       |
| -------- | -------- | --------- |
| Need X   | Use Y    | Because Z |
| Need A   | Use B    | Because C |
```

**Critical for AI:** A good decision matrix eliminates 80% of clarifying questions. Agents can pattern-match their current task to the right approach.

### 4. Core Patterns (Code Examples)

````markdown
## Core Patterns

### [Pattern Name]

[1-2 sentence context]

```typescript
// Complete, runnable example
// Comments explain WHY, not WHAT
export function example() {
  // This pattern ensures X because Y
  return result;
}
```
````

````

**Requirements:**
- Examples must be complete (copy-paste ready)
- Include imports if non-obvious
- Comments explain reasoning, not mechanics

### 5. Anti-Patterns

```markdown
## Anti-Patterns

```typescript
// ❌ NEVER do this
badPattern()  // Causes X problem

// ✅ Do this instead
goodPattern() // Prevents X, ensures Y
````

````

**Why essential:** AI agents learn from negative examples. Without anti-patterns, agents may generate common mistakes that "look right" but violate project conventions.

### 6. Step-by-Step Procedures (Optional)

Include when there are procedural tasks (adding X, configuring Y):

```markdown
## Adding a New [Thing]

1. **Create the file**: `path/to/file.ts`
   ```typescript
   // Initial content
````

2. **Register in config**: Add to `config.ts`

   ```typescript
   // What to add
   ```

3. **Verify**: Run `npm run [command]` and check for [expected output]

````

**Key:** Each step should have verification. Agents need to confirm success before proceeding.

### 7. Troubleshooting (Optional but Recommended)

```markdown
## Troubleshooting

### "Error message verbatim"

**Cause**: Why this happens
**Fix**: What to do

### [Symptom description]

**Cause**: Why this happens
**Fix**: What to do
````

**Why this format:** AI agents can grep for error messages and find solutions directly.

## Writing Guidelines

### For AI Agent Consumption

| Do                              | Don't                            |
| ------------------------------- | -------------------------------- |
| Use tables for structured data  | Use prose for comparisons        |
| Put decision criteria in tables | Bury decisions in paragraphs     |
| Make code examples complete     | Show fragments requiring context |
| Use consistent section headers  | Vary section names across guides |
| Include file paths in examples  | Assume agents know locations     |

### For Human Readability

| Do                              | Don't                                   |
| ------------------------------- | --------------------------------------- |
| Keep overview under 3 sentences | Write lengthy introductions             |
| Use bullet points for lists     | Use numbered lists unless order matters |
| Link to related guides          | Duplicate content from other guides     |
| Explain "why" in comments       | Over-document obvious code              |

## Quality Checklist

Before completing a guide, verify:

- [ ] Overview explains what AND why in 2-3 sentences
- [ ] Key Files table maps concepts to locations
- [ ] Decision matrix covers common scenarios
- [ ] All code examples are complete and runnable
- [ ] Anti-patterns section exists with ❌/✅ format
- [ ] Troubleshooting covers common errors (if applicable)
- [ ] Section order matches this skill's template
- [ ] No duplicated content from other guides (link instead)

## Updating INDEX.md

After creating or modifying a guide:

1. Add/update entry in Guide Coverage Map table
2. Add pattern matching rules (file patterns + keywords)
3. Update Maintenance Tracking with today's date

See `contributing/INDEX.md` for the format.

## References

For the complete section-by-section template with detailed examples, see:
`reference.md` in this skill directory.
