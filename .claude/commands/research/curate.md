---
description: Curate research files — inventory by type, identify stale/superseded candidates, update frontmatter status
argument-hint: '[reduce]'
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(date:*), Bash(rm:*), Bash(du:*)
category: documentation
---

# Curate Research Files

Keep the `research/` library curated. **Default invocation is non-interactive**: inventory, apply the status heuristics, backfill frontmatter, stamp the marker, report. The destructive file-reduction flow (prune/merge/condense) runs **only** when invoked with the `reduce` argument.

Skip `research/README.md` and `research/plan.md` (meta files) in all steps.

## Default pass (non-interactive)

### 1. Inventory

Glob all `.md` files in `research/`. For each, read the YAML frontmatter or infer from the filename/content: **date** (frontmatter, `YYYYMMDD_` filename prefix, or file mtime), **type** (`external-best-practices | internal-architecture | strategic | implementation | exploratory`), **status** (`active | archived | superseded`), **title**, **feature_slug**.

### 2. Apply the curation heuristics

Without asking, make these frontmatter-only changes (never delete or restructure content in this pass):

| Condition                                                                                                      | Action                                                               |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| No frontmatter at all (legacy file)                                                                            | **Backfill** frontmatter (title, date, type, `status: active`, tags) |
| `internal-architecture` and a related ADR exists in `decisions/` (search by topic keywords, not just filename) | `status: archived` (codified)                                        |
| `implementation` and its `feature_slug` maps to a completed/implemented spec in `specs/manifest.json`          | `status: archived` (shipped)                                         |
| Clearly superseded by a newer report or an ADR                                                                 | `status: superseded` + `superseded_by: <path>`                       |
| Frontmatter says active but body says superseded/archived (inconsistent state)                                 | Flip status to match reality                                         |
| Older than 60 days, `status: active`, no `feature_slug`                                                        | Judgment call: archive if clearly drifted from relevance, else keep  |

Lifecycle policy by type: `external-best-practices` — keep unless clearly outdated (note strong `contributing/` promotion candidates in the report rather than promoting unprompted); `strategic` — keep as historical record; `exploratory` — archive when superseded or abandoned.

When adding or editing frontmatter, preserve all content below the frontmatter block.

### 3. Stamp the marker

```bash
date -u +"%Y-%m-%dT%H:%M:%SZ" > research/.last-curated
```

This resets the SessionStart maintenance nag (`.claude/hooks/session-maintenance.sh`); `/adr:review` stamps the analogous `decisions/.last-reviewed`. Stamp at the end of the default pass regardless of whether `reduce` runs.

### 4. Report

Summarize: total files and size; counts by type; what changed (archived / superseded / backfilled, with filenames); promotion candidates worth considering; anything ambiguous that was left alone and why. If many archived/superseded files have accumulated, suggest `/research:curate reduce`.

## `reduce` mode (interactive, destructive)

Run the default pass first, then these phases — **each destructive action needs user confirmation**, and remind the user to commit uncommitted changes before starting (`git` makes this reversible).

### Prune

List all files with `status: archived` or `status: superseded`, with sizes (`du`). On confirmation (all-at-once or reviewed individually), `rm` them.

### Merge

Find redundant pairs: same `type`, ≥2 matching tags, created within 14 days of each other, both `status: active`. For each approved pair: keep the more recent/comprehensive file, append the source file's unique content under `## Additional Notes (merged from <source-filename>)`, add `merged_from:` to the canonical file's frontmatter, delete the source.

### Condense

List `status: active` files over 400 lines. For each approved file, rewrite to 40-60% of original length — preserve frontmatter (add `condensed: true`), key findings, recommendations with rationale, important code examples, and decision outcomes; cut elaboration of obvious points, repetition, and background restating public knowledge.

### Reduction report

Files pruned (+ KB freed), pairs merged, files condensed (with before/after line counts), and before/after totals for the library. Tip: `git diff --stat` to review before committing.

## Notes

- `feature_slug` values should match entries in `specs/manifest.json`
- Run periodically (monthly); the SessionStart nag fires when `research/.last-curated` is stale
