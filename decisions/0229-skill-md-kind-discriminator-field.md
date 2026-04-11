---
number: 229
title: Add Optional `kind` Discriminator Field to SKILL.md Frontmatter
status: proposed
created: 2026-04-06
spec: marketplace-01-foundation
extractedFrom: marketplace-01-foundation
superseded-by: null
related: [220]
---

# 229. Add Optional `kind` Discriminator Field to SKILL.md Frontmatter

## Status

Draft (auto-extracted from spec: marketplace-01-foundation). This is an addendum to ADR-0220.

## Context

ADR-0220 established SKILL.md as the universal file format for skills, tasks, and commands in DorkOS, with location-based inference determining each file's purpose: `.dork/tasks/foo/SKILL.md` is a task, `.claude/skills/foo/SKILL.md` is a skill, and so on. ADR-0220 explicitly deferred adding a `kind` discriminator field as unnecessary for local installations.

The marketplace introduces a new constraint: SKILL.md files travel inside marketplace packages where the package author chooses arbitrary directory layouts. When the installer unpacks a package and decides where each SKILL.md file should land, location-based inference is brittle — the source path inside the package is not the destination path.

Without an explicit `kind` field, the installer must guess based on TaskFrontmatter shape (e.g., "has cron → it's a task"), which is fragile and breaks if SKILL.md gains future variants.

## Decision

Add an optional `kind` field to `SkillFrontmatterSchema` in `@dorkos/skills`:

```typescript
export const SkillKindSchema = z.enum(['skill', 'task', 'command']);

export const SkillFrontmatterSchema = z.object({
  // ...existing fields...
  kind: SkillKindSchema.optional(),
});
```

The field is **optional**. Existing SKILL.md files continue to work unchanged.

**Inference rules** when `kind` is absent:

1. If `cron` field present → `task`
2. If file is under `commands/` or `.claude/commands/` → `command`
3. Otherwise → `skill`

**Marketplace package authors SHOULD include `kind` explicitly** to make file intent unambiguous across installation contexts. **User-created files** (not destined for marketplace distribution) MAY omit it and rely on location-based inference.

## Consequences

### Positive

- Marketplace packages can declare file intent explicitly without depending on directory layout
- The installer in spec 02 doesn't need to maintain inference heuristics for unfamiliar package layouts
- Forward-compatible: future SKILL.md kinds (e.g., `mcp-tool`, `hook`) can be added to the enum
- Fully backward compatible: ADR-0220's location-based inference remains the default

### Negative

- Two ways to determine kind (explicit field vs. inference) increases the rule surface
- Marketplace packages and user files now follow slightly different conventions (though both are valid)
- Small modification to ADR-0220 instead of a clean separation
