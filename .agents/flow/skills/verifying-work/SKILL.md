---
name: verifying-work
description: The /flow engine's VERIFY stage — trace recent work for correctness, run the verification gate, gather proof-of-completion scaled to the change, attach it to the work item, and hand off to the human-review gate. Use when running /flow:verify or advancing a work item into the VERIFY stage.
---

# Verifying Work — the VERIFY stage

> **Stage:** VERIFY (spec §1). One generic, PM-agnostic stage skill.
> **Absorbs:** today's `/review-recent-work`, browser proof-of-completion, and
> code review (the `browser-testing`, `requesting-code-review`, and
> `verification-before-completion` skills).
> **PM projection (Linear):** evidence attached to the work item / PR.
> **Trigger doors:** the thin `/flow:verify` command _or_ a PM transition into
> the VERIFY stage are two triggers for this one skill.

VERIFY is the proof stage. It answers one question with evidence, never
assertion: _does the implementation actually do what the spec asked, and is it
ready for a human to approve?_ It ends by parking at the **human-review gate**
(REVIEW) — VERIFY never declares the work done itself (that is DONE, after a
human approves).

## The one tracker rule

This is a generic stage skill. **It never touches a tracker API string.**
Attaching evidence, assigning the reviewer, and any breadcrumb go through the
**`linear-adapter`** skill by naming its verbs (`attachEvidence`,
`assignToHuman`, `comment`, `transition`). No raw tracker tool name, CLI
invocation, or slug lives here. (The `tracker-confinement` Vitest guard enforces
this for the whole flow bundle.)

## Process

### 1. Correctness trace (absorbs `/review-recent-work`)

Trace the recently-changed files and functions to verify the implementation is
**correct and complete**, fixing issues found in place:

- Identify the files/functions modified since the change's base (e.g. the spec's
  base SHA, or `git diff` against the merge base).
- For each function: state what it does, its callers, its callees, then trace the
  logic for correctness.
- Correct any issue found during the trace.

This is the quick inline self-review. Escalate to the structured code review
(step 3) when the change spans packages/layers, touches shared interfaces or
schemas, or is headed to main.

### 2. The verification gate (absorbs `verification-before-completion`)

**The Iron Law: no completion claim without fresh verification evidence.** Before
asserting any status, run the proving command _in this pass_ and read its full
output — confidence is not evidence. Scale the commands to the change:

| Claim          | Command                                  |
| -------------- | ---------------------------------------- |
| Tests pass     | `pnpm vitest run [path]` → 0 failures    |
| Linter clean   | `pnpm lint` → 0 errors/warnings          |
| Types check    | `pnpm typecheck` → 0 errors              |
| Build succeeds | `pnpm build` → exit 0                    |
| Bug fixed      | original symptom test passes (red→green) |

Prefer package-filtered commands when scoped (`pnpm vitest run <file>`,
`dotenv -- turbo typecheck --filter=@dorkos/<pkg>`). Trust no agent's "success"
report without checking the VCS diff. The full `verification-before-completion`
skill carries the rationalization-prevention table — read it when tempted to
skip.

### 3. Structured code review (absorbs `requesting-code-review`)

For non-trivial changes, dispatch the `code-reviewer` subagent rather than
self-reviewing. Follow the `requesting-code-review` skill to obtain the base/head
SHAs, assemble the review context (what was implemented · the task spec from
`03-tasks.json` · base/head SHAs · a summary), dispatch the subagent, and act on
its feedback. The reviewer reads actual code against the spec and DorkOS
standards (FSD layers, SDK import confinement, architecture boundaries, test
coverage) — it never trusts the implementer's narrative.

### 4. Proof-of-completion bundle (browser proof)

Gather proof **scaled to the surface touched** (spec §13), following the
`browser-testing` skill for the methodology:

- **UI change** → run Playwright (`apps/e2e`) for the touched surface; capture an
  annotated GIF (interactive runs) or the WebM already wired in `apps/e2e`
  (unattended).
- **Temporal behavior** → video.
- **Server / logic** → the test-pass summary from step 2.

`evidence.ui: "auto"` selects GIF vs WebM by trigger (interactive vs unattended).

> ### ⚠️ P4 wires the full evidence pipeline (task 4.1 / DOR-95)
>
> **This task (P1) ships the VERIFY skill skeleton + the thin `/flow:verify`
> command — it captures the stage's intent and the review-gate handoff. The
> FULL browser proof-of-completion pipeline is P4.**
>
> Specifically deferred to P4:
>
> - The unattended/server variant: headless `recordVideo` → automated tracker
>   `fileUpload` / `attachmentCreate` (the P5 Extension's job, DOR-95).
> - The ProofShot-style PR-comment bundle and the `evidence` config block
>   (`evidence.ui`, `evidence.attachTo`) that drives format + attach target.
> - Auto-selection of capture format by trigger across every surface.
>
> Until P4 lands, VERIFY attaches what an interactive/CLI run can already produce
> — the `apps/e2e` WebM and the verification-command summaries — and otherwise
> documents the gap rather than faking proof.

### 5. Attach evidence + open the review (via `linear-adapter`)

Project the proof onto the work item — the single audit surface:

- Via the adapter, `attachEvidence(item, evidence)` — the proof bundle (test
  summary, recordings, PR link) attached per the evidence config's `attachTo`.
- Open / update the PR with the linked work item, the test/validation summary,
  and the proof links (the `templates/pr.md` scaffold).

### 6. Hand off to the human-review gate (REVIEW)

The **human-review gate is always on** (spec §5). VERIFY does not advance to
DONE. Instead, via the adapter:

- `transition` the work item into the review state (Linear: In Review).
- `assignToHuman(item)` — assign the reviewer, which fires their notification.
- **Stop.** The engine **parks** at REVIEW. REVIEW is a human gate with **no
  skill** — there is no `reviewing-work`. The loop resumes (in P2) only on the
  human's approval, after which DONE (`closing-work`) and the auto-merge recovery
  ladder run.

If no work item is linked or the tracker is unavailable, skip the tracker steps
silently and report the evidence inline — tracker integration is always optional.

## Calibration (spec §5)

VERIFY is an **execution stage**: in the ambiguous middle (reversible +
not-confident) it **proceeds on the best default and logs the assumption** rather
than stopping. The floor (row 0) still stops and asks via the adapter's
`needsInput`. But VERIFY's _output_ is itself the human gate — every assumption
logged during EXECUTE/VERIFY surfaces here for the human to approve.

## Guardrails

- Evidence before claims, always (the Iron Law). No "should"/"probably"/"seems".
- VERIFY never closes the loop — it parks at REVIEW. DONE is a separate stage.
- REVIEW has no skill; do not invent a reviewing skill or auto-approve.
- All tracker I/O through `linear-adapter`. No tracker strings in this skill.
