---
description: Process post-implementation feedback with interactive decisions
category: workflow
allowed-tools: Read, Grep, Glob, Write, Edit, Agent, AskUserQuestion
argument-hint: '<path-to-spec-file>'
---

# Process Post-Implementation Feedback

Process ONE specific piece of feedback from testing/usage of an implemented spec: explore the affected code, optionally research approaches, gather decisions, and record the outcome in the spec's feedback log.

## Phase 1: Validation & Setup

Extract the slug from the spec path (`specs/<slug>/02-specification.md` → `<slug>`).

Verify the implementation exists: `specs/<slug>/04-implementation.md` must be present. If missing, stop with "Run `/flow:execute` first" (requires the flow plugin, `dork-labs/marketplace`, loaded via `--plugin-dir`). If `specs/<slug>/03-tasks.json` shows incomplete tasks, mention it as a warning — not a blocker.

## Phase 2: Feedback Collection

If the user hasn't already provided the feedback, ask for ONE specific piece of feedback from testing (what's wrong or could be improved, with context/repro; one issue per session).

Categorize it: **Bug/Error** (fail, crash, broken), **Performance** (slow, timeout), **UX/UI** (confusing, unclear), **Security** (auth, permission), or **General**. The category steers where the exploration looks.

## Phase 3: Discovery (background agents)

Always dispatch an **Explore** agent in the background to investigate the affected code. Its brief: read `specs/<slug>/02-specification.md` for component names and file paths; investigate the code areas implicated by the feedback type; and report affected components (file paths with how each relates), blast radius (direct changes / indirect impact / tests affected), immediate concerns, and recommended changes per file.

If the issue is complex enough that best-practice research would help (offer the choice for non-obvious issues), also dispatch a **research-expert** agent in parallel: identify the core technical challenge, compare 2-3 solution approaches with pros/cons, and report a recommended approach plus pitfalls to avoid.

Background agents notify on completion — no polling needed. Continue when their findings are in.

## Phase 4: Interactive Decisions

Present a findings summary (feedback, type, exploration findings, research findings if any), then gather the decisions that are genuinely the user's call — via AskUserQuestion:

1. **Action** — Implement now (update spec, re-run implementation) / Defer (log for later) / Out of scope (log only)
2. **Scope** (if implementing) — Minimal (just the issue) / Comprehensive (plus related improvements) / Phased (quick fix now, comprehensive later)
3. **Approach** (if implementing and discovery surfaced multiple viable approaches) — pick among them
4. **Priority** (if implementing or deferring) — Critical / High / Medium / Low

## Phase 5: Execute the Decision

### If "Implement now"

Add a changelog entry to `specs/<slug>/02-specification.md`:

```markdown
### [date] - Post-Implementation Feedback

**Source:** Feedback #[N] (see specs/<slug>/05-feedback.md)
**Issue:** [feedback text]
**Decision:** Implement with [scope] scope
**Changes to Specification:** [affected sections]
**Implementation Impact:** priority, approach, affected components (from exploration)
**Next Steps:** update affected spec sections, then `/flow:decompose` and `/flow:execute` on the spec
```

Then update the affected spec sections and point the user at the decompose/execute follow-up.

### If "Defer"

Record it fully in the feedback log (Phase 6) with `Status: deferred` and the priority. Offer to capture it to the tracker via `/flow:capture` so it enters the work queue rather than dying in the log.

### If "Out of scope"

Log only (Phase 6).

## Phase 6: Update the Feedback Log

Append to `specs/<slug>/05-feedback.md` (create if missing; number entries sequentially):

```markdown
## Feedback #[N]

**Date:** [date-time]
**Status:** [implemented | deferred | out-of-scope]
**Type:** [category] · **Priority:** [priority]

### Description

[feedback text]

### Findings

[exploration summary; research summary or "skipped"]

### Decisions

Action / Scope / Approach / Priority as selected

### Actions Taken

[what was done]
```

Close with a brief completion summary: feedback number, decision, files updated, and next steps if implementing.

## Integration

- `/flow:execute` must have completed before this command (it produces `04-implementation.md`)
- After "Implement now": `/flow:decompose` then `/flow:execute` on the updated spec
