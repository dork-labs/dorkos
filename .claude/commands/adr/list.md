---
description: Display all Architecture Decision Records in a formatted table
allowed-tools: Read, Glob
category: documentation
---

# List Architecture Decision Records

## Steps

### Step 1: Read Manifest

Read `decisions/manifest.json` to get all decision entries.

### Step 2: Display Main Table

Format and display all ADRs as a markdown table, sorted by id:

```markdown
## Architecture Decision Records

| #    | Title                           | Status   | Date       | Spec                  |
| ---- | ------------------------------- | -------- | ---------- | --------------------- |
| 0001 | [Title](decisions/0001-slug.md) | accepted | 2026-02-06 | claude-code-webui-api |
| 0002 | [Title](decisions/0002-slug.md) | accepted | 2026-02-15 | fsd-architecture      |
```

### Step 3: Display Summary

```
Total: N decisions (A accepted, P proposed, X deprecated, S superseded)
```

If the proposed count is large, suggest `/adr:review` to progress the backlog.

## Notes

- Sort by id (legacy 4-digit numbers sort before timestamp ids under a plain string sort — that's chronological)
- Link titles to the actual files
- Show spec slug if linked, "—" if not
- Status uses lowercase
