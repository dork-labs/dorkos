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

Format and display all non-draft ADRs as a markdown table, sorted by number:

```markdown
## Architecture Decision Records

| #    | Title                           | Status   | Date       | Spec                  |
| ---- | ------------------------------- | -------- | ---------- | --------------------- |
| 0001 | [Title](decisions/0001-slug.md) | accepted | 2026-02-06 | claude-code-webui-api |
| 0002 | [Title](decisions/0002-slug.md) | accepted | 2026-02-15 | fsd-architecture      |
```

### Step 3: Display Draft ADRs (if any)

If any entries have `"status": "draft"`, show a separate section:

```markdown
### Draft ADRs (pending curation)

| #    | Title                           | Date       | Extracted From |
| ---- | ------------------------------- | ---------- | -------------- |
| 0006 | [Title](decisions/0006-slug.md) | 2026-02-18 | spec-slug      |

Run `/adr:curate` to promote or archive these.
```

If no drafts exist, skip this section entirely.

### Step 4: Display Summary

```
Total: N decisions (A accepted, P proposed, D draft, X deprecated, S superseded)
```

## Notes

- Sort by number (chronological)
- Link titles to the actual files
- Show spec slug if linked, "—" if not
- Status uses lowercase
