---
description: Evaluate draft ADRs and promote significant ones, archive trivial ones
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(mkdir:*), Bash(mv:*), Bash(date:*), Bash(node:*)
category: documentation
---

# Curate Draft ADRs

---

## Steps

### Step 0: Scan for On-Disk Drift

Run the drift detector — it catches integrity problems the manifest-only steps below cannot see (orphan `decisions/NNNN-*.md` files whose number is absent from the manifest, slug collisions where a number maps to a different ADR, or manifest entries with no file):

```bash
node .claude/scripts/adr-drift-check.mjs
```

If it reports drift, reconcile before curating drafts:

- **Orphan / collision files** (uncurated leftovers, usually from `/adr:from-spec` runs whose numbers were later reassigned): verify the decision isn't already recorded elsewhere in the manifest, then either archive it (`mv decisions/NNNN-{slug}.md decisions/archive/NNNN-{slug}.md`) or, if it is a still-valid decision missing from the record, give it a fresh number from `nextNumber` and register it. Never silently delete — archiving preserves recoverable content.
- **Missing files** (manifest entry with no file): restore the file or remove the stale manifest entry.

This step runs even when no manifest drafts exist (orphans can exist with zero drafts). If it prints nothing, there is no drift — continue.

### Step 1: Read Draft ADRs

Read `decisions/manifest.json` and filter for entries with `"status": "draft"`.

If no drafts exist:

1. Update `decisions/.last-curated` with current ISO timestamp
2. Display: "No draft ADRs to curate."
3. Exit.

### Step 2: Evaluate Each Draft

For each draft ADR:

1. Read the full ADR file at `decisions/NNNN-{slug}.md`
2. Evaluate against these significance criteria (from the `writing-adrs` skill):

| #   | Criterion                                  | How to Assess                                                                |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| 1   | **Chooses between alternatives**           | Does the ADR describe selecting X over Y? Or just "we used X"?               |
| 2   | **Project-wide impact**                    | Does this affect how future features are built, beyond the originating spec? |
| 3   | **Would surprise a new team member**       | Is this a non-obvious choice that needs explanation?                         |
| 4   | **Adopts a lasting pattern or technology** | New library, architecture pattern, data model with long-term consequences?   |

3. Score: count how many criteria are met (0-4)
4. Decision:
   - **Score >= 2**: Promote (draft -> proposed)
   - **Score <= 1**: Archive

### Step 3: Promote Significant ADRs

For each ADR to promote:

1. Edit the ADR file:
   - Change frontmatter `status: draft` to `status: proposed`
   - Change Status section from "Draft (auto-extracted...)" to "Proposed"
2. Update `decisions/manifest.json`: change the entry's status to `"proposed"`

### Step 4: Archive Trivial ADRs

For each ADR to archive:

1. Move the file: `mv decisions/NNNN-{slug}.md decisions/archive/NNNN-{slug}.md`
2. Remove the entry from `decisions/manifest.json` `decisions` array

### Step 5: Update Timestamp

Write current ISO timestamp to `decisions/.last-curated`:

```bash
date -u +"%Y-%m-%dT%H:%M:%SZ" > decisions/.last-curated
```

### Step 6: Display Summary

```
ADR Curation Complete

  Promoted (draft -> proposed):
    - 0006: [Title]
    - 0007: [Title]

  Archived:
    - 0008: [Title] -> decisions/archive/0008-[slug].md
    - 0009: [Title] -> decisions/archive/0009-[slug].md

  Summary: N promoted, M archived
```

## Notes

- This command is typically triggered automatically via SessionStart hook
- It can also be run manually at any time: `/adr:curate`
- Archived ADRs are preserved in `decisions/archive/` but removed from the manifest
- To recover an archived ADR, manually move it back and re-add to manifest
