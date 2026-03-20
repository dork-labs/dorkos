---
description: Curate research files — inventory by type, identify stale/superseded candidates, update frontmatter status
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(date:*), Bash(rm:*), Bash(du:*)
category: documentation
---

# Curate Research Files

Systematically review the `research/` directory, display an inventory grouped by type, identify curation candidates, and update file frontmatter based on decisions.

---

## Steps

### Step 1: Inventory All Research Files

Glob all `.md` files in `research/`. For each file, read its YAML frontmatter (if present) or infer metadata from filename and content headers.

Build an inventory record for each file:

- **filename** — e.g. `20260222_turborepo_env_vars_dotenv_cli.md`
- **date** — from frontmatter `date` field, or inferred from `YYYYMMDD_` filename prefix, or "unknown"
- **type** — from frontmatter `type` field, or "unclassified"
- **status** — from frontmatter `status` field, or "unclassified"
- **title** — from frontmatter `title` field, or first H1/H2 heading in the file, or filename
- **feature_slug** — from frontmatter `feature_slug`, or empty

### Step 2: Display Inventory Table

Print a summary grouped by type. Within each group, sort by date descending.

```
Research Inventory (N files, M MB)
────────────────────────────────────────────────────────────────────
TYPE: external-best-practices (N files)
  DATE        STATUS      TITLE
  2026-02-28  active      Graph Topology Visualization — World-Class Patterns
  2026-02-17  active      World-Class Developer Docs
  ...

TYPE: internal-architecture (N files)
  DATE        STATUS      TITLE
  2026-02-24  active      Relay Core Library — TypeScript Options
  ...

TYPE: implementation (N files)
  ...

TYPE: strategic (N files)
  ...

TYPE: exploratory (N files)
  ...

TYPE: unclassified (N files)  ← legacy files without frontmatter
  ...
────────────────────────────────────────────────────────────────────
```

### Step 3: Identify Curation Candidates

Flag files meeting any of these criteria:

| Criterion                                                                                                 | Why                               |
| --------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Older than 60 days with `status: active` and no `feature_slug`                                            | May have drifted from relevance   |
| `type: internal-architecture` and a related ADR exists in `decisions/`                                    | Likely codified — safe to archive |
| Duplicate/overlapping topic (same keywords, within 7 days of each other)                                  | Possible redundancy               |
| Already `status: superseded` or `status: archived` but frontmatter not updated                            | Inconsistent state                |
| `type: implementation` and the associated feature appears shipped (feature_slug maps to a completed spec) | Implementation complete           |
| No frontmatter at all (legacy files)                                                                      | Needs backfill                    |

Print a curation candidates list:

```
Curation Candidates (N files)
────────────────────────────────────────────────────────────────────
1. research/20260218_agent-sdk-context-injection.md
   Reason: internal-architecture, ADR 0012 covers SDK context injection
   Current status: unclassified

2. research/pulse-scheduler-design.md
   Reason: implementation, Pulse feature shipped (spec: pulse-scheduler)
   Current status: unclassified

3. research/20260217_world_class_developer_docs.md
   Reason: >60 days old, no feature_slug, status: active
   Current status: active
...
────────────────────────────────────────────────────────────────────
```

### Step 4: Process Each Candidate

For each candidate, apply the appropriate action based on context. Use the lifecycle policy:

| Type                      | Policy                                                                     |
| ------------------------- | -------------------------------------------------------------------------- |
| `external-best-practices` | Keep unless clearly outdated. Promote strong candidates to `contributing/` |
| `internal-architecture`   | Archive once codified into ADRs or contributor docs                        |
| `strategic`               | Keep as historical record                                                  |
| `implementation`          | Archive once the feature is shipped and stable                             |
| `exploratory`             | Archive when superseded or abandoned                                       |

**For each candidate, take one of these actions:**

**A. Mark as `archived`** — update frontmatter `status: archived`

**B. Mark as `superseded`** — update frontmatter:

```yaml
status: superseded
superseded_by: research/YYYYMMDD_newer_file.md # or decisions/NNNN-slug.md
```

**C. Promote to `contributing/`** — for high-quality evergreen best-practices that have permanent value as developer guides. Copy content, update frontmatter to `status: archived` with note, and create/update the relevant `contributing/*.md` file.

**D. Backfill frontmatter** — for legacy files without YAML frontmatter, infer and add:

```yaml
---
title: 'Inferred from first heading'
date: YYYY-MM-DD # from filename prefix or file mtime
type: <inferred> # best guess from content
status: active # default — curator can override
tags: [inferred, keywords]
---
```

**E. Keep as-is** — no changes needed.

### Step 5: Update Frontmatter

For each file that needs changes, use the Edit tool to update (or add) YAML frontmatter. Preserve all existing content below the frontmatter block.

When adding frontmatter to a legacy file that has none, prepend:

```
---
[fields]
---

[existing content]
```

### Step 6: Display Summary

```
Research Curation Complete
────────────────────────────────────────────────────────────────────
  Archived (N files):
    - 20260218_agent-sdk-context-injection.md
    - pulse-scheduler-design.md

  Marked superseded (N files):
    - 20260217_world_class_developer_docs.md → superseded_by: 20260228_og_seo_ai_readability_overhaul.md

  Frontmatter backfilled (N files):
    - ngrok-research.md
    - dorkos-config-file-system.md

  Promoted to contributing/ (N files):
    - 20260222_scheduler_dashboard_ui_best_practices.md → contributing/scheduler-ux.md

  No action needed (N files)

  Summary: N archived, M superseded, P backfilled, Q promoted
────────────────────────────────────────────────────────────────────
```

---

### Transition: File Reduction

After displaying the Step 6 summary, ask the user:

```
Would you like to continue with file reduction? This will:
  - Prune:    Delete N archived/superseded files (~X KB freed)
  - Merge:    Review M redundant file pairs
  - Condense: Shorten P verbose files (>400 lines)

[Yes, run all] [Prune only] [Merge only] [Condense only] [Skip]
```

If the user selects any reduction option, remind them to commit any uncommitted changes first, then proceed with the selected phases sequentially.

---

### Step 7: Prune (Delete Archived/Superseded Files)

**Goal**: Physically remove files that are no longer useful and have already been marked for removal.

**Input**: Files with `status: archived` or `status: superseded` (identified during Steps 1–4).

**Process**:

1. Build the deletion candidate list: all files where `status: archived` OR `status: superseded`. Use `Bash(du:*)` to get file sizes.
2. Display the list and ask for confirmation:

   ```
   Prune: Delete N archived/superseded files?
   ────────────────────────────────────────────
   archived (N files):
     - 20260218_agent-sdk-context-injection.md (14 KB)
     - pulse-scheduler-design.md (38 KB)
     ...
   superseded (N files):
     - 20260222_relay_core_library_typescript.md → superseded_by: 20260224_... (27 KB)
     ...

   Total: ~X KB freed
   [Delete all] [Review individually] [Skip]
   ```

3. For **"Delete all"**: run `rm research/<filename>` for each file in the list.
4. For **"Review individually"**: show each file's title + first 5 lines of content, then ask [Delete] [Keep].
5. Track deleted count and total KB freed for the Step 10 summary.

---

### Step 8: Merge Redundant Files

**Goal**: Consolidate pairs of files that cover the same topic into one canonical file.

**Redundancy detection** — a pair is a merge candidate if ALL of the following are true:

- Same `type`
- ≥2 matching tags
- Created within 14 days of each other
- Both have `status: active`

**Process**:

1. Compare frontmatter across all active files to build candidate pairs.
2. Display merge candidates:

   ```
   Merge Candidates (N pairs)
   ────────────────────────────────────────────
   Pair 1: relay runtime adapters (overlap: relay, adapter, runtime)
     A: 20260224_relay_runtime_adapters.md (285 lines, Feb 24)
     B: 20260225_relay_runtime_adapters.md (320 lines, Feb 25)
     → Suggested: Keep B (more recent, more content). Absorb unique content from A.

   Pair 2: drizzle + sqlite (overlap: drizzle, sqlite, driver)
     A: 20260225_drizzle_sqlite_drivers.md (155 lines)
     B: drizzle-db-migrations.md (201 lines)
     → Suggested: Keep B (more comprehensive). Absorb unique content from A.
   ...
   ```

3. For each pair, ask: [Merge (keep B)] [Merge (keep A)] [Skip this pair]
4. For approved merges:
   a. Read both files.
   b. Identify content in the "source" file not present in the "canonical" file.
   c. Append unique sections to the canonical file under a `## Additional Notes (merged from [source-filename])` heading.
   d. Update the canonical file's frontmatter: add `merged_from: [source-filename]` field.
   e. Delete the source file: `rm research/<source-filename>`.
5. Track merged pair count for the Step 10 summary.

---

### Step 9: Condense Verbose Files

**Goal**: Rewrite overly long files as tighter summaries, preserving key conclusions and removing elaboration.

**Threshold**: Files with `status: active` and >400 lines.

**Process**:

1. List verbose files sorted by line count descending:
   ```
   Verbose Files (N files over 400 lines)
   ────────────────────────────────────────────
   1. loop-mvp.md                           1,195 lines  (exploratory)
   2. scheduling-approaches-analysis.md     1,041 lines  (implementation)
   3. torq-litepaper-v2.md                  1,037 lines  (strategic)
   4. relay_core_library_typescript.md        777 lines  (internal-architecture)
   ...
   ```
2. For each file, ask: [Condense] [Skip]
3. For approved condensations:
   a. Read the full file.
   b. Rewrite it, **preserving**:
   - YAML frontmatter (unchanged, add `condensed: true` field)
   - Key findings and conclusions
   - Specific recommendations with rationale
   - Important code examples
   - Decision outcomes
     c. **Remove**:
   - Long elaborations of obvious points
   - Repetitive bullet lists covering the same idea
   - Sections marked "background" that restate public knowledge
   - Verbose prose where bullet points suffice
     d. Target: 40–60% of original line count.
     e. Overwrite the original file using `Write`.
4. Track original and final line counts for each condensed file for the Step 10 summary.

---

### Step 10: Reduction Summary

After all selected phases complete:

```
Research Reduction Complete
────────────────────────────────────────────
  Pruned:    N files deleted (~X KB freed)
  Merged:    M pairs consolidated → M files deleted
  Condensed: P files rewritten (avg N% reduction)

  Before: 86 files, ~42,000 lines
  After:  N files, ~N lines

  Tip: Run `git diff --stat` to review all changes before committing.
────────────────────────────────────────────
```

---

## Notes

- Steps 1–6 (curation) only edit frontmatter — they never delete or restructure files
- Steps 7–9 (reduction) are destructive — always confirm before deleting or overwriting; `git` makes changes reversible
- Files `research/README.md` and `research/plan.md` are meta files — skip them in all steps
- When checking for related ADRs, search `decisions/` by topic keywords, not just filename
- `feature_slug` values should match entries in `specs/manifest.json`
- Run `/research:curate` periodically (e.g. monthly) to keep the research library curated
