---
name: managing-roadmap-moscow
description: Manages product roadmaps using MoSCoW prioritization. Use when working with project roadmaps, feature prioritization, or product planning tasks.
---

# Roadmap MoSCoW Management

This skill provides tools and methodology for managing product roadmaps using MoSCoW prioritization (Must-Have, Should-Have, Could-Have, Won't-Have).

## When to Use

- Adding, updating, or reviewing roadmap items
- Analyzing roadmap health and balance
- Validating roadmap JSON structure
- Generating roadmap summaries
- Checking Must-Have percentage (should be <60%)

## Roadmap Location

The roadmap data lives at `/roadmap/roadmap.json`

## Python Utilities

All scripts use Python 3 stdlib only (no pip dependencies).

### Validate Roadmap

```bash
python3 .claude/skills/managing-roadmap-moscow/scripts/validate_roadmap.py
```

Validates `roadmap.json` against the JSON schema. Returns exit code 0 if valid.

### Sort Items

```bash
# Sort by MoSCoW priority (must -> should -> could -> won't)
python3 .claude/skills/managing-roadmap-moscow/scripts/sort_items.py --by moscow

# Sort by status
python3 .claude/skills/managing-roadmap-moscow/scripts/sort_items.py --by status

# Sort by time horizon
python3 .claude/skills/managing-roadmap-moscow/scripts/sort_items.py --by horizon
```

### Check Health

```bash
python3 .claude/skills/managing-roadmap-moscow/scripts/check_health.py
```

Analyzes roadmap health:
- Must-Have % (warns if >60%)
- Items at risk or blocked
- Items missing effort estimates
- Dependency issues

### Generate Summary

```bash
python3 .claude/skills/managing-roadmap-moscow/scripts/generate_summary.py
```

Outputs a text summary of the roadmap suitable for stakeholder communication.

## MoSCoW Methodology

See [moscow-guide.md](moscow-guide.md) for the complete MoSCoW methodology reference.

## PM Principles

See [pm-principles.md](pm-principles.md) for startup product management principles.

## Editing the Roadmap

When making changes to `roadmap.json`:

1. Always update `lastUpdated` timestamp
2. Always update item's `updatedAt` when modifying
3. Run validation after changes
4. Keep Must-Have items <60% of total effort

## JSON Schema

The schema is defined at `/roadmap/schema.json`. Key rules:
- Item IDs must be valid UUID v4
- `moscow` must be one of: must-have, should-have, could-have, wont-have
- `status` must be one of: not-started, in-progress, completed, on-hold
- `health` must be one of: on-track, at-risk, off-track, blocked
- `timeHorizon` must be one of: now, next, later

## Roadmap-Claude Code Integration

### Automatic Activation Triggers

The managing-roadmap-moscow skill is automatically applied when:
- User mentions "roadmap" in prompts
- Working on files in `roadmap/` directory
- Running `/ideate` with `--roadmap-id` or `--roadmap-item` flag
- Running `/spec:execute` on specs with `roadmapId` frontmatter
- Running `/roadmap` commands (view, add, enrich, etc.)
- Editing `roadmap.json` or `schema.json`

### Automatic Status Updates

The roadmap skill can autonomously update item status when:
- **Starting ideation**: Set status to `in-progress` when `/ideate --roadmap-id` is run
- **Completing implementation**: Set status to `completed` when `/spec:execute` finishes all tasks

### Linking Specs to Roadmap Items

When creating specs for roadmap items:
1. Use the item's UUID with `--roadmap-id` flag
2. The slug will be derived from the item title
3. Links will be automatically added to the roadmap item

### Utility Commands

```bash
# Update item status
python3 roadmap/scripts/update_status.py <item-id> <status>

# Link spec to item
python3 roadmap/scripts/link_spec.py <item-id> <spec-slug>

# Generate slug from title
python3 roadmap/scripts/slugify.py <title-or-item-id>

# Find item by title
python3 roadmap/scripts/find_by_title.py "<title-query>"
```

### Best Practices

1. Always use `--roadmap-id` when ideating from a roadmap item
2. Check linkedArtifacts before starting work (avoid duplicate specs)
3. Run validation after any roadmap updates
4. Keep ideationContext fields populated for better ideation prompts
