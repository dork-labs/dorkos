---
name: closing-work
description: The /flow engine's DONE stage — report completion on a work item, move it to Done with the agent/completed label, create any follow-up work, run a project pulse check for the next loop action, and clean up the worktree. Use when running /flow:done or advancing an approved work item into the DONE stage.
---

# Closing Work — the DONE stage

> **Stage:** DONE (spec §1). One generic, PM-agnostic stage skill.
> **Absorbs:** the legacy `/linear:done` close flow (retired in spec #257).
> **PM projection (Linear):** Done state + `agent/completed` label.
> **Trigger doors:** the thin `/flow:done` command _or_ a PM transition into the
> DONE stage are two triggers for this one skill.

DONE is an **intentional** act — "I'm satisfied; close the loop." It runs only
**after the human-review gate (REVIEW) has approved** the work (and, in the
autonomous loop, after the auto-merge recovery ladder has merged a green,
cleanly-mergeable diff — spec §6). It reports completion, advances the work item,
seeds the next loop phase, and tears down the workspace.

## The one tracker rule

This is a generic stage skill. **It never touches a tracker API string.** The
completion comment, the Done transition, the `agent/completed` label, follow-up
creation, relation links, and the project pulse-check reads all go through the
**`linear-adapter`** skill by naming its verbs (`comment`, `transition`,
`createSubIssue`, `link`, `getProjects`, `getEligibleWork`, `getRelations`). No
raw tracker tool name, CLI invocation, or slug lives here. (The
`tracker-confinement` Vitest guard enforces this for the whole flow bundle.)

## Process

### 1. Identify the work item

- Use the explicitly provided identifier (e.g. `DOR-123`) when present.
- Otherwise infer only from strong local context: the spec's provenance block /
  `linear-issue:` frontmatter, or an item claimed earlier in this session.
- If still ambiguous, ask a short bounded question. Do not close casually.

### 2. Build the completion summary

- **What was done** — a brief summary.
- **Evidence** — proof scaled to the work (the VERIFY bundle): the test command +
  pass summary for server/logic work; a screenshot or annotated GIF for UI work;
  video only for temporal behavior. Paste/attach it on the item.
- **Files changed** (if applicable) and the spec directory link (if routed
  through the spec workflow).
- **Follow-ups** needed; for hypotheses, whether the validation criteria were
  met.

### 3. Comment + advance the item (via `linear-adapter`)

- Via the adapter, `comment(item, body)` — post the completion summary (carries
  the agent's `identity.marker`).
- Via the adapter, `transition(item, "done")` — move to a `completed`-category
  state and set `agent/completed`, clearing `agent/claimed`. **Match on state
  category, never on the display name** — the adapter owns that mapping.

### 4. Create follow-up work (when required)

Driven by the item's type and its `## On Completion` routing:

- `type/hypothesis` → via the adapter, create a `type/monitor` item carrying the
  hypothesis's validation criteria (origin labelled as from-agent).
- If this item was blocking others, note that they are now unblocked (read via
  the adapter's `getRelations`); use `link` only for genuinely typed relations.

### 5. Completion routing + project pulse check

- Read the item's `## On Completion` section first — it is the most specific
  signal for what to recommend next; when it is absent, fall back to the
  project pulse-check rules below.
- Run a **project pulse check** (skip if the item has no project): via the
  adapter, read remaining items in the same project, group by type + state
  category, and apply the loop-continuity rules:
  - All research Done, no hypothesis/spec → recommend `/flow:ideate` (complex) or
    creating `type/task` sub-issues (simple).
  - All tasks under a hypothesis Done → recommend closing the parent hypothesis.
  - All monitors cleared → recommend moving the project to Completed.
  - Zero remaining active items → check `specs/manifest.json` for an active spec
    linked to this project; if one exists, do **not** recommend closing.
- Present the project state, the recommended next action, and offer to run it. If
  no transition is detected, report the project status briefly.

### 6. Clean up the workspace

If the work ran in a dedicated git worktree (recorded in the spec's
`04-implementation.md`, or detected when `git rev-parse --git-dir
--git-common-dir` prints two different paths) and its branch is merged, offer
`/worktree:remove <branch> --delete-branch`. If the session is currently inside
that worktree, **leave it first** (ExitWorktree, or return to the main checkout)
before removing. Follow the `working-in-worktrees` cleanup safety — never remove
a worktree with uncommitted, untracked, or unpushed work; confirm first.

### 7. Report

Report what was closed, any follow-up created, and the project-pulse next-action
recommendation. Name every work item as identifier with title (`DOR-157 - Title`,
per the linear-adapter display convention), never the bare key.

## Guardrails

- DONE is intentional and gated — never close an item casually or before REVIEW
  approval.
- Do not skip the project pulse check unless the item has no project context and
  no clear parent flow.
- Prefer the item's explicit `## On Completion` routing over generic defaults.
- Filesystem stays canonical; the tracker holds pointers + state + conversation,
  never a second copy of the prose.
- All tracker I/O through `linear-adapter`. No tracker strings in this skill. If
  the tracker is unavailable, explain the limitation clearly rather than guessing.
