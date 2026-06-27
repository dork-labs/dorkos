---
name: verifying-work
description: The /flow engine's VERIFY stage — trace recent work for correctness, run the verification gate, gather proof-of-completion scaled to the change, attach it to the work item, and hand off to the human-review gate. Use when running /flow:verify or advancing a work item into the VERIFY stage.
---

# Verifying Work — the VERIFY stage

> **Stage:** VERIFY (spec §1). One generic, PM-agnostic stage skill.
> **Absorbs:** today's `/review-recent-work`, browser proof-of-completion, and
> code review (the `browser-testing`, `requesting-code-review`, and
> `verification-before-completion` skills).
> **PM projection (tracker):** evidence attached to the work item / PR.
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
**adapter** skill by naming its verbs (`attachEvidence`,
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
`browser-testing` skill for the methodology. The format and attach target are
**config-driven from the `evidence` block** of `.agents/flow/config.json` — never
hand-picked. The pinned oracle for that decision is the flow engine's
`selectEvidence`: given the change `kind`, the
run's trigger (`liveSession`), and the resolved `evidence` config, it returns an
`EvidencePlan` — the capture format, the tool that produces it, and where the
bundle attaches. Follow its result; do not re-derive the choice by hand.

**Resolve the capture per class** (what `selectEvidence` returns):

- **UI change** (`kind: "ui"`) → run Playwright (`apps/e2e`) for the touched
  surface. `evidence.ui` picks the format; `"auto"` (default) resolves on the
  trigger:
  - **interactive** run (a live CLI/session) → an **annotated GIF** via
    claude-in-chrome's `gif_creator` (per-action keyframes with click/label
    overlays).
  - **unattended** run (no live session) → a **WebM** via Playwright's
    `recordVideo` — the path already wired in `apps/e2e`
    (`video: 'retain-on-failure'` in `playwright.config.ts`).
  - `evidence.ui: "screenshot"` pins a still; `"off"` skips UI capture.
- **Temporal behavior** (`kind: "temporal"`) → a moving recording regardless of
  trigger: `evidence.temporal` is `"video"` (WebM) by default, `"gif"` forces the
  annotated GIF, `"off"` skips it.
- **Server / logic** (`kind: "logic"`) → the verification-gate summary from step 2:
  `evidence.logic` is `"test-summary"` by default, `"full-output"` attaches the raw
  command output, `"off"` skips it.

The capture _format_ keys off whether a live interactive session is attached right
now (the same `liveSession` signal the comms router uses), never off the autonomy
of the run: `/flow auto` is autonomous yet interactive (annotated GIF reachable);
a Pulse tick is autonomous and unattended (WebM `recordVideo`).

> ### Scope boundary — v1 (this skill) vs the P5 server extension
>
> **v1 (here, interactive/CLI) attaches what an interactive or CLI run can already
> produce:** the `apps/e2e` **WebM** (`recordVideo`, headless), any `gif_creator`
> capture from a live interactive session, and the verification-command summaries.
> The selector (`selectEvidence`) and the attach step below are the full v1
> pipeline; nothing here is a placeholder.
>
> **Deferred to the P5 server extension, NOT built here:** the
> fully **unattended/server variant** — headless `recordVideo` driven by the
> server-side VERIFY runner, then **automated** tracker `fileUpload` /
> `attachmentCreate` of the artifact (binary upload) with no human in the loop. v1
> attaches _links/URLs_ to the produced artifacts via the adapter (step 5); P5
> promotes that to server-driven binary upload + the headless capture loop. When P5
> lands, `selectEvidence`'s output is unchanged — only the executor moves
> server-side. Until then, if a capture cannot be produced (e.g. no live session
> _and_ no `apps/e2e` run for the surface), VERIFY **documents the gap rather than
> faking proof**.

### 5. Attach evidence + open the review (via the adapter)

Project the proof onto the work item — the single audit surface. The plan's
`attachTo` (from `selectEvidence`, echoing `evidence.attachTo`, default
`["pr", "tracker"]`) decides which of these fire:

- **`"pr"`** → assemble the **ProofShot-style bundle** into the PR comment: the
  test/validation summary, the recording link(s) (the `apps/e2e` WebM and/or the
  `gif_creator` GIF), and the linked work item. Open / update the PR with the
  `templates/pr.md` scaffold.
- **`"tracker"`** → via the adapter, `attachEvidence(item, evidence)` — the same
  bundle attached onto the work item's `externalUrls` (a link to each artifact + a
  link to the PR). Route this through the **adapter** verb; never touch a
  tracker string here.

If a class resolved to a `"none"` capture, its `attachTo` is empty — there is no
bundle to attach, and VERIFY says so rather than inventing one.

### 6. Hand off to the human-review gate (REVIEW)

The **human-review gate is always on** (spec §5). VERIFY does not advance to
DONE. Instead, via the adapter:

- `transition` the work item into the review state (e.g. In Review).
- `assignToHuman(item)` — assign the reviewer, which fires their notification.
- **Stop.** The engine **parks** at REVIEW. REVIEW is a human gate with **no
  skill** — there is no `reviewing-work`. The loop resumes (in P2) only on the
  human's approval, after which DONE (`closing-work`) and the auto-merge recovery
  ladder run. **In v1 there is no approval detection:** after you approve and merge
  the PR, run `/flow:done <issue>` to move the item to Done and tear down the
  worktree — the unattended approval→merge resume is the P2 server Extension.

When you report the handoff to the operator, name the work item as identifier with
title (`PROJ-157 - Title`, per the adapter's display convention), never the
bare key.

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
- All tracker I/O through the adapter. No tracker strings in this skill.
