---
description: Validate the roadmap JSON structure
argument-hint: "(no arguments)"
allowed-tools: Bash
category: roadmap
---

# Roadmap Validate

Validate the roadmap.json file against the schema to ensure data integrity.

## Usage

```
/roadmap:validate
```

## Implementation

Run the validation script:

```bash
python3 .claude/skills/managing-roadmap-moscow/scripts/validate_roadmap.py
```

## What It Checks

- JSON syntax is valid
- All required fields are present
- UUIDs are properly formatted
- Enum values are valid:
  - `moscow`: must-have, should-have, could-have, wont-have
  - `status`: not-started, in-progress, completed, on-hold
  - `health`: on-track, at-risk, off-track, blocked
  - `timeHorizon`: now, next, later
  - `type`: feature, bugfix, improvement, maintenance, research
- Timestamps are valid ISO format
- Dependencies reference existing item IDs
- No duplicate IDs

## Output

On success:
```
✅ Roadmap validation passed
```

On failure:
```
❌ Validation errors found:
- Item "abc123": Invalid moscow value "critical"
- Item "def456": Missing required field "title"
- Item "ghi789": Dependency "xyz" not found
```
