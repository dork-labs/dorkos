---
title: Automatic ADR Extraction & Curation
description: Implementation plan for automatic architectural decision capture from specs.
---

# Automatic ADR Extraction & Curation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically capture architectural decisions from specs as draft ADRs, then curate them daily via background process.

**Architecture:** Two-phase system — Phase 1 modifies `/ideate-to-spec` to inline-extract draft ADRs after spec validation. Phase 2 adds a new `/adr:curate` command triggered by a SessionStart hook that promotes significant drafts and archives trivial ones.

**Tech Stack:** Claude Code slash commands (.md), shell hooks (.sh), JSON manifest

**Date:** 2026-02-18
**Status:** Approved

## Problem

ADR creation is manual — `/ideate-to-spec` suggests running `/adr:from-spec` as a next step, but it's easy to forget. Architectural decisions embedded in specs go undocumented. We want to capture every decision automatically, then separate the significant from the trivial over time.

## Design

Two-phase system: **capture everything first, curate later.**

### Phase 1: Inline Auto-Extract

**Where:** New Step 7.5 in `/ideate-to-spec`, after spec validation and before the summary.

**What it does:**

1. Reads `specs/{slug}/01-ideation.md` and `specs/{slug}/02-specification.md`
2. Checks `decisions/manifest.json` for existing ADRs referencing this spec (avoids duplicates)
3. Scans for decision signals using the `writing-adrs` skill criteria:
   - Technology choices ("We chose X over Y")
   - Pattern adoption (architectural patterns, libraries)
   - Trade-off resolutions ("We decided to...")
   - Rejected alternatives ("We considered X but...")
4. For each candidate, writes a draft ADR file using the standard template with `status: draft`
5. Updates `decisions/manifest.json` with all new entries
6. Adds a line to the Step 7 summary: "Auto-extracted N draft ADRs from this spec"

**Key differences from `/adr:from-spec`:**

- No interactive candidate selection (captures everything)
- Status is `draft` not `proposed`
- No significance filtering — that's Phase 2's job
- Runs as part of the existing workflow, not a separate command

**Step 7.7 changes from:**
```
2. [ ] Consider extracting ADRs: `/adr:from-spec {slug}`
```
**To:**
```
2. [x] Auto-extracted N draft ADRs (run `/adr:curate` to promote significant ones)
```

The existing `/adr:from-spec` command stays as-is for retroactive extraction or manual control.

### Phase 2: Daily Background Curation

**New command:** `/adr:curate`

**Trigger:** A SessionStart hook checks `decisions/.last-curated` timestamp. If >24h old and draft ADRs exist, it prints a hint. Claude sees this and automatically runs `/adr:curate` via a background subagent.

**Curation process:**

1. Reads `decisions/manifest.json`, filters for `status: "draft"` entries
2. If no drafts exist, exits silently (updates `.last-curated` timestamp)
3. For each draft ADR, evaluates against the `writing-adrs` skill criteria:
   - Does it choose between alternatives? (not just "we used X")
   - Does it have project-wide impact beyond the originating spec?
   - Would it surprise a new team member?
   - Does it adopt a lasting pattern or technology?
4. **Promote** (draft -> proposed): ADRs that meet 2+ criteria
5. **Archive** (draft -> archived): ADRs that meet 0-1 criteria — moved to `decisions/archive/` and removed from manifest
6. Updates `decisions/.last-curated` with current timestamp
7. Outputs summary: "Promoted N, archived M draft ADRs"

## ADR Lifecycle Changes

New statuses added to existing lifecycle:

```
draft → proposed → accepted → deprecated/superseded
  ↓
archived (moved to decisions/archive/)
```

- **`draft`**: Raw decision capture from auto-extraction. Not yet evaluated for significance.
- **`archived`**: Curation determined this is trivial/single-feature-scope. Moved to `decisions/archive/`, removed from manifest.

Manual `/adr:create` continues to create `proposed` ADRs (skips draft).

## File & Manifest Changes

**New files:**

| File | Purpose |
|------|---------|
| `decisions/archive/` | Directory for archived draft ADRs |
| `decisions/.last-curated` | Single-line ISO timestamp |
| `.claude/commands/adr/curate.md` | Curation command |
| `.claude/hooks/check-adr-curation.sh` | SessionStart hook script |

**Modified files:**

| File | Change |
|------|--------|
| `.claude/commands/ideate-to-spec.md` | Add Step 7.5 (auto-extract) |
| `.claude/commands/adr/list.md` | Show drafts in separate section |
| `.claude/skills/writing-adrs/SKILL.md` | Document `draft` and `archived` statuses |
| `.claude/settings.json` | Add SessionStart hook for curation check |

**Manifest schema addition:**

```json
{
  "number": 6,
  "slug": "use-sse-for-streaming",
  "title": "Use SSE for Server-to-Client Streaming",
  "status": "draft",
  "created": "2026-02-18",
  "specSlug": "cross-client-session-sync",
  "extractedFrom": "cross-client-session-sync"
}
```

`extractedFrom` is only set on auto-extracted ADRs. Archived entries are removed from the manifest array entirely.

Draft ADRs consume real ADR numbers from `nextNumber` — if promoted, the number stays stable. Gaps from archiving are fine.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Re-run `/ideate-to-spec` on spec with existing drafts | Checks `extractedFrom` in manifest, skips if already extracted |
| Promoted ADR overlaps with existing accepted ADR | Curation checks title/topic similarity, archives the draft instead |
| Spec created via `/spec:create` (bypassing `/ideate-to-spec`) | Manual `/adr:from-spec` still available; auto-extract only runs in `/ideate-to-spec` |
| Zero decision signals in a spec | Step 7.5 is a no-op, summary says "No decision signals found" |
| Spec abandoned after draft ADRs created | Drafts fail significance criteria during curation and get archived naturally |

## Scope

- **In scope:** Extraction from specs only (01-ideation.md, 02-specification.md)
- **Out of scope:** Implementation-time decisions, commit messages, conversation mining

---

## Implementation Plan

### Task 1: Update TEMPLATE.md and manifest schema for `draft` status

**Files:**
- Modify: `decisions/TEMPLATE.md`
- Create: `decisions/archive/.gitkeep`

**Step 1: Update the ADR template to document new statuses**

Edit `decisions/TEMPLATE.md` line 5 to include `draft` and `archived`:

```markdown
status: draft | proposed | accepted | deprecated | superseded | archived
```

**Step 2: Create the archive directory**

```bash
mkdir -p decisions/archive
touch decisions/archive/.gitkeep
```

**Step 3: Commit**

```bash
git add decisions/TEMPLATE.md decisions/archive/.gitkeep
git commit -m "feat(adr): add draft/archived statuses and archive directory"
```

---

### Task 2: Update `writing-adrs` skill to document new lifecycle

**Files:**
- Modify: `.claude/skills/writing-adrs/SKILL.md`

**Step 1: Add draft and archived to the ADR Lifecycle table**

Edit `.claude/skills/writing-adrs/SKILL.md` — replace the ADR Lifecycle table (lines 66-73) with:

```markdown
## ADR Lifecycle

| Status | Meaning |
|--------|---------|
| `draft` | Auto-extracted from spec, not yet evaluated for significance |
| `proposed` | Under discussion or promoted from draft, not yet committed |
| `accepted` | Active decision guiding implementation |
| `deprecated` | No longer relevant (project evolved past it) |
| `superseded` | Replaced by a newer ADR (link via `superseded-by`) |
| `archived` | Curation determined this is trivial; moved to `decisions/archive/` |

### Auto-Extraction

Draft ADRs are created automatically by `/ideate-to-spec` (Step 7.5) when a spec is validated. Every decision signal is captured as a draft. The `/adr:curate` command (triggered daily via SessionStart hook) evaluates drafts against the criteria in "When to Write an ADR" above:
- **Promote** (draft → proposed): Meets 2+ criteria
- **Archive** (draft → archived): Meets 0-1 criteria, moved to `decisions/archive/`
```

**Step 2: Commit**

```bash
git add .claude/skills/writing-adrs/SKILL.md
git commit -m "docs(adr): document draft/archived lifecycle in writing-adrs skill"
```

---

### Task 3: Add Step 7.5 to `/ideate-to-spec`

**Files:**
- Modify: `.claude/commands/ideate-to-spec.md`

**Step 1: Insert Step 7.5 (Auto-Extract Draft ADRs) after the Step 7 header**

Insert the following new section between Step 7.2 (Summarize Specification Content, ends ~line 620) and Step 7.3 (List Decisions Made, starts ~line 624). The new step runs *before* the summary is displayed, so extracted ADR count can be referenced in the summary.

Actually — more precisely, insert a new top-level step between Step 7 (present summary) and before the sub-steps of Step 7 begin. The extraction needs to happen *before* the summary is built. Insert after the Step 7 header (line 579-580) and before sub-step 7.1 (line 583):

```markdown
### Step 7.0: Auto-Extract Draft ADRs

Automatically extract architectural decisions from the spec as draft ADRs. This runs silently with no user interaction.

#### 7.0.1: Check for Existing Extractions

Read `decisions/manifest.json`. Check if any entries have `"extractedFrom": "{slug}"`. If entries already exist, skip extraction entirely and set `autoExtractedCount = 0` with note "Draft ADRs already extracted for this spec."

#### 7.0.2: Read Spec Documents

Read both:
1. `specs/{slug}/01-ideation.md`
2. `specs/{slug}/02-specification.md`

#### 7.0.3: Scan for Decision Signals

Identify decision candidates by scanning for these signals (from the `writing-adrs` skill):

| Signal | Pattern |
|--------|---------|
| Technology choices | "We chose X", "Using X instead of Y", library/framework selections |
| Pattern adoption | Architectural patterns, design systems, data flow approaches |
| Trade-off resolutions | "We decided to...", "The recommended approach is..." |
| Rejected alternatives | "We considered X but...", "Option A vs Option B" |
| Deliberate exclusions | "We will not...", "Out of scope because..." |

For each candidate, extract:
- **Title**: Short imperative form (e.g., "Use SSE for Server-to-Client Streaming")
- **Context**: 2-5 sentences from the spec's problem/research sections
- **Decision**: 2-5 sentences from the spec's design/recommendation sections
- **Consequences**: Positive and negative trade-offs from the spec

#### 7.0.4: Write Draft ADRs

For each candidate decision:

1. Read `decisions/manifest.json` for current `nextNumber`
2. Create ADR file at `decisions/NNNN-{kebab-slug}.md` using the standard template:

```
---
number: NNNN
title: [Title]
status: draft
created: [today's date]
spec: {slug}
superseded-by: null
---

# NNNN. [Title]

## Status

Draft (auto-extracted from spec: {slug})

## Context

[2-5 sentences extracted from spec]

## Decision

[2-5 sentences extracted from spec]

## Consequences

### Positive

- [From spec trade-off analysis]

### Negative

- [From spec trade-off analysis]
```

3. Update `decisions/manifest.json`: increment `nextNumber`, add entry with `"status": "draft"`, `"extractedFrom": "{slug}"`, and `"specSlug": "{slug}"`

Repeat for all candidates, incrementing the number each time.

#### 7.0.5: Record Extraction Count

Set `autoExtractedCount` to the number of draft ADRs created. This will be displayed in the Step 7 summary.
```

**Step 2: Update Step 7.7 (Recommended Next Steps)**

In the "If READY FOR DECOMPOSITION" next steps block (~line 749-756), replace:

```markdown
2. [ ] Consider extracting ADRs: `/adr:from-spec {slug}`
```

With:

```markdown
2. [x] Auto-extracted {autoExtractedCount} draft ADRs (run `/adr:curate` to promote significant ones)
```

If `autoExtractedCount` is 0 and the skip note was set, show:

```markdown
2. [x] Draft ADRs already extracted for this spec
```

Also remove the ADR suggestion from the "If NEEDS WORK" block if present.

**Step 3: Commit**

```bash
git add .claude/commands/ideate-to-spec.md
git commit -m "feat(adr): add auto-extract Step 7.0 to ideate-to-spec"
```

---

### Task 4: Create `/adr:curate` command

**Files:**
- Create: `.claude/commands/adr/curate.md`

**Step 1: Write the curation command**

Create `.claude/commands/adr/curate.md`:

```markdown
---
description: Evaluate draft ADRs and promote significant ones, archive trivial ones
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(mkdir:*), Bash(mv:*), Bash(date:*)
category: documentation
---

# Curate Draft ADRs

---

## Steps

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

| # | Criterion | How to Assess |
|---|-----------|---------------|
| 1 | **Chooses between alternatives** | Does the ADR describe selecting X over Y? Or just "we used X"? |
| 2 | **Project-wide impact** | Does this affect how future features are built, beyond the originating spec? |
| 3 | **Would surprise a new team member** | Is this a non-obvious choice that needs explanation? |
| 4 | **Adopts a lasting pattern or technology** | New library, architecture pattern, data model with long-term consequences? |

3. Score: count how many criteria are met (0-4)
4. Decision:
   - **Score >= 2**: Promote (draft → proposed)
   - **Score <= 1**: Archive

### Step 3: Promote Significant ADRs

For each ADR to promote:

1. Edit the ADR file:
   - Change frontmatter `status: draft` → `status: proposed`
   - Change Status section from "Draft (auto-extracted...)" → "Proposed"
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

  Promoted (draft → proposed):
    - 0006: [Title]
    - 0007: [Title]

  Archived:
    - 0008: [Title] → decisions/archive/0008-[slug].md
    - 0009: [Title] → decisions/archive/0009-[slug].md

  Summary: N promoted, M archived
```

## Notes

- This command is typically triggered automatically via SessionStart hook
- It can also be run manually at any time: `/adr:curate`
- Archived ADRs are preserved in `decisions/archive/` but removed from the manifest
- To recover an archived ADR, manually move it back and re-add to manifest
```

**Step 2: Commit**

```bash
git add .claude/commands/adr/curate.md
git commit -m "feat(adr): add /adr:curate command for draft promotion and archival"
```

---

### Task 5: Create SessionStart hook for daily curation

**Files:**
- Create: `.claude/hooks/check-adr-curation.sh`
- Modify: `.claude/settings.json`

**Step 1: Write the hook script**

Create `.claude/hooks/check-adr-curation.sh`:

```bash
#!/bin/bash
# Check if ADR curation is due (>24h since last run) and draft ADRs exist
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
LAST_FILE="$REPO_ROOT/decisions/.last-curated"
MANIFEST="$REPO_ROOT/decisions/manifest.json"

# Check if manifest exists
if [ ! -f "$MANIFEST" ]; then
  exit 0
fi

# Count draft ADRs
DRAFT_COUNT=$(node -e "
  const m = require('$MANIFEST');
  const drafts = (m.decisions || []).filter(d => d.status === 'draft');
  console.log(drafts.length);
" 2>/dev/null || echo "0")

# No drafts, nothing to do
if [ "$DRAFT_COUNT" = "0" ]; then
  exit 0
fi

# Check timestamp
NEEDS_CURATION=false
if [ ! -f "$LAST_FILE" ]; then
  NEEDS_CURATION=true
else
  LAST_TS=$(cat "$LAST_FILE" 2>/dev/null || echo "")
  if [ -z "$LAST_TS" ]; then
    NEEDS_CURATION=true
  else
    # Compare timestamps (macOS compatible)
    LAST_EPOCH=$(date -jf "%Y-%m-%dT%H:%M:%SZ" "$LAST_TS" +%s 2>/dev/null || echo "0")
    NOW_EPOCH=$(date +%s)
    DIFF=$(( NOW_EPOCH - LAST_EPOCH ))
    if [ "$DIFF" -gt 86400 ]; then
      NEEDS_CURATION=true
    fi
  fi
fi

if [ "$NEEDS_CURATION" = "true" ]; then
  echo "[ADR Curation Due] $DRAFT_COUNT draft ADR(s) pending review — run /adr:curate"
fi
```

**Step 2: Make it executable**

```bash
chmod +x .claude/hooks/check-adr-curation.sh
```

**Step 3: Add SessionStart hook to settings.json**

Edit `.claude/settings.json` — add to the `"SessionStart": []` array (line 85):

```json
"SessionStart": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "cd \"$(git rev-parse --show-toplevel)\" && .claude/hooks/check-adr-curation.sh"
      }
    ]
  }
]
```

**Step 4: Commit**

```bash
git add .claude/hooks/check-adr-curation.sh .claude/settings.json
git commit -m "feat(adr): add SessionStart hook for daily curation check"
```

---

### Task 6: Update `/adr:list` to show draft ADRs separately

**Files:**
- Modify: `.claude/commands/adr/list.md`

**Step 1: Update the list command**

Edit `.claude/commands/adr/list.md` to show drafts in a separate section after the main table:

Replace the current Step 2 and Step 3 content with:

```markdown
### Step 2: Display Main Table

Format and display all non-draft ADRs as a markdown table:

| # | Title | Status | Date | Spec |
|---|-------|--------|------|------|
| 0001 | [Title](decisions/0001-slug.md) | accepted | 2026-02-06 | claude-code-webui-api |

### Step 3: Display Draft ADRs (if any)

If any entries have `"status": "draft"`, show a separate section:

```
### Draft ADRs (pending curation)

| # | Title | Date | Extracted From |
|---|-------|------|----------------|
| 0006 | [Title](decisions/0006-slug.md) | 2026-02-18 | spec-slug |

Run `/adr:curate` to promote or archive these.
```

If no drafts exist, skip this section entirely.

### Step 4: Display Summary

```
Total: N decisions (A accepted, P proposed, D draft, X deprecated, S superseded)
```
```

**Step 2: Commit**

```bash
git add .claude/commands/adr/list.md
git commit -m "feat(adr): show draft ADRs in separate section in /adr:list"
```

---

### Task 7: Add `.last-curated` to `.gitignore`

**Files:**
- Modify: `.gitignore` (or create `decisions/.gitignore`)

**Step 1: Add gitignore entry**

The `.last-curated` file is machine-local state. Create `decisions/.gitignore`:

```
.last-curated
```

**Step 2: Commit**

```bash
git add decisions/.gitignore
git commit -m "chore: gitignore decisions/.last-curated timestamp file"
```

---

### Task 8: End-to-end verification

**Step 1: Verify all files exist**

```bash
ls -la decisions/TEMPLATE.md
ls -la decisions/archive/.gitkeep
ls -la decisions/.gitignore
ls -la .claude/commands/adr/curate.md
ls -la .claude/hooks/check-adr-curation.sh
```

**Step 2: Verify hook is registered**

```bash
node -e "const s = require('./.claude/settings.json'); console.log(JSON.stringify(s.hooks.SessionStart, null, 2))"
```

Expected: Should show the curation hook entry.

**Step 3: Test the hook script runs cleanly**

```bash
.claude/hooks/check-adr-curation.sh
```

Expected: Either no output (no drafts) or the curation-due message.

**Step 4: Verify manifest schema is intact**

```bash
node -e "const m = require('./decisions/manifest.json'); console.log('nextNumber:', m.nextNumber, 'decisions:', m.decisions.length)"
```

Expected: `nextNumber: 6 decisions: 5`

**Step 5: Commit if any fixups needed, then final commit**

```bash
git log --oneline -8
```

Verify 7 commits from tasks 1-7 are present.
