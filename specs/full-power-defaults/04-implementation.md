# Implementation Summary: Full Power by Default

**Created:** 2026-08-22
**Last Updated:** 2026-08-23
**Spec:** specs/full-power-defaults/02-specification.md
**Tracker:** DOR-1431 (umbrella) · DOR-1432 (defaults flips) · DOR-1433 (Control Center)

## Progress

**Status:** Implemented — all tasks shipped, all PRs merged.

## What shipped

DorkOS now treats full autonomy as a first-class, consent-led default rather than a
scary corner setting. A user meets the power question exactly once — new users during
onboarding, existing users through a one-time modal on a new moments rail — and the
whole surface reads _green = unlocked, red = alarm_ instead of the old red-means-danger
framing. Nothing consent-gated flips silently: the door's Accept is what writes the
flips, through the same gated paths (the A1 invariant).

### Feature + spec PRs

| PR    | Branch                 | What it delivered                                                                                                                          |
| ----- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| #1192 | `fpd-spec`             | Spec, decision records (4 ADRs), task breakdown                                                                                            |
| #1199 | `fpd-moments-rail`     | One-time **moments rail**; telemetry consent moved from banner → modal                                                                     |
| #1201 | `fpd-green-flip`       | Full power reads **green**; red reserved for genuine alarm                                                                                 |
| #1204 | `fpd-defaults-flips`   | Warm agents + 4-way schedule concurrency by default; **unattended surfaces follow the operator's level**; adapter `canInitiate` (DOR-1432) |
| #1210 | `fpd-door`             | The **full-power consent door** — one click to unlock, or keep asking                                                                      |
| #1209 | `fpd-control-center`   | **Control Center** — see and change agents' power at a glance; respects overrides (DOR-1433)                                               |
| #1225 | `fpd-onboarding-power` | New users **choose their power level** during onboarding                                                                                   |

### Follow-up fixes (found during the program, its reviews, and dogfooding)

| PR    | Branch                           | What it fixed                                                                                                                                                                                                                 |
| ----- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1208 | `fix-timeline-settle-refresh`    | Timeline keeps your exact scroll spot after the view settles                                                                                                                                                                  |
| #1227 | `fix-moments-fetch-gate`         | Moments open reliably for undecided users on **cold and post-update** launches (the persister version-bust made every post-update launch look cold; the door would have silently no-showed on the exact launch it exists for) |
| #1239 | `fix-timeline-node-icon`         | Completed timeline-node icon is legible on its green fill (a11y)                                                                                                                                                              |
| #1240 | `fix-permission-copy-reword`     | **Full-autonomy copy names the approval gate**, not "runs without asking" (see Deviations)                                                                                                                                    |
| #1241 | `fix-onboarding-deeplink-anchor` | Onboarding deep-links hold their step on a cold load; unknown `?onboarding=` values degrade instead of crashing (DOR-1431)                                                                                                    |
| #1248 | `fix-main-moments-red`           | Un-red `main` — the suppression test now mocks the gate #1227 actually reads (`dataUpdatedAt`, not the retired `isFetchedAfterMount`)                                                                                         |

## Accepted deviations from the spec

- **The reword (#1240).** User feedback surfaced mid-program: "runs without asking"
  read as "the agent will never ask me anything," and one user thought turning on full
  autonomy had cancelled a standing instruction to check with her. It hadn't — the
  permission mode governs the **approval gate** (the card that halts a tool call), not
  whether the agent asks questions. All _attended_ surfaces now name what actually turns
  off (the approval prompt) and say plainly the agent still asks when something needs a
  call and still follows anything you told it to check first. _Unattended_ surfaces
  (scheduled tasks, chat bindings with nobody watching) and Codex's "can't pause to ask"
  keep their honest wording — promising they'll ask would be a worse lie. Verified
  against the code: `AskUserQuestion` routes **before** the mode gate, so the "still
  asks" claim is architecturally true.
- **Customize… omitted during onboarding.** The door's `onCustomize` link opens the
  Control Center, which is not mounted while the onboarding overlay is up. During setup
  the door hides the link entirely (`onCustomize` made optional) rather than offering a
  dead affordance.
- **Standing grants are login-gated.** Deferred behind the existing auth/login path
  rather than shipped open, matching the consent-led invariant.
- **CLI full-power parity command** deferred at spec time; not implemented (follow-up).

## Decision records (all now `accepted`)

- `260822-235759` — consent-led default flipping (the door writes the flips, never a migration)
- `260822-235800` — one-time modals ride a moments rail
- `260822-235801` — green means full power, red means alarm
- `260822-235802` — unattended surfaces follow the operator level

## How agents talk to each other (recorded for the reword's second claim)

Full power does **not** _enable_ agent-to-agent communication — agents already talk
within a project. Two transports carry it: **Relay** (a subject-addressed bus —
`relay_send`/`_and_wait`/`_async` over one `relay.publish` primitive) and **Rooms**
(durable-log channels). **Mesh** is the address book + access-rule authority, not a
transport. What full power widens is **openMesh** (a `*→*` access rule): it lets an
agent **reach across your other projects**, rather than only its own. That is the
correct meaning of the door's second bullet, and #1240 corrected the copy to say so.

## Program follow-ups (filed / to file on the tracker)

- **conf@15 `store`-getter migration-test hazard** — the getter re-parses `config.json`
  per access and validates a throwaway copy, so Ajv `useDefaults` never writes defaults
  to the file. Any migration test asserting via `configManager.get`/`getDot` alone is
  vacuous; several pre-existing "no-op anchor" comments rest on a claim that is wrong for
  the file (harmless today only because those bodies write the same values). Audit
  migration tests to assert **on-disk**.
- **`runtimes.claudeCode.*` is agent-writable while `persistentSession` is
  PROTECTIVE_CARRYOVERS-protected** — an agent PATCH can flip a wipe-protected value with
  no UI to notice. Pre-existing write-policy question, broader than this program.
- **Contrast token follow-up** — `text-status-success` light-mode contrast was marginal
  (4.40–4.47:1) and is now used more widely by the green flip; darkened in #1239's
  vicinity. The Obsidian bridge pins `--color-status-success` flat (~3.30:1 on a white
  theme) and is the only shipped consumer of `SessionRowSidebar` — verify there.
- **Vocabulary alignment** — session details said "Permissions: Bypass All" while the
  mark announced full power. Fixed in DOR-1499: the details panel now says "Full power"
  for any bypass-semantics mode, matching the mark, and `useSessionPermissionSummary()`'s
  field is renamed `isFullPower` (its three callers, all updated).
- **CLI full-power parity command** (deferred at spec time).
- **Flaky tests to ticket** (surfaced under CI saturation; each passes in isolation):
  `apps/desktop/src/main/__tests__/agent-activity.test.ts:190` ("stops for good once
  stopped", SSE timing) and
  `apps/client/src/layers/features/command-palette/__tests__/palette-scope-chips.test.tsx`
  ("leaves no agent and no channel", scope-chip assertion under load).

## Implementation notes

Orchestrated from Claude session `session_01Bme3TpshkbtdJEwY3Amyym`, seat in the main
checkout. Per-task gtr worktrees under `~/.dork/workspaces/dorkos/` (operator-mandated
per-PR isolation). Pipeline per task: Opus/Sonnet implementer (background, resumable) →
stage-1 spec-compliance review → stage-2 adversarial review per `REVIEW.md` (separate
workers) → fixes via continuing the implementer → PR → merge queue.

Two lessons worth carrying (added to memory):

- **`test` is not a required check**, so a cross-PR interaction can land red on `main`
  through the merge queue unnoticed. #1225 (the suppression test) and #1227 (the gate it
  reads) merged close together; the test went red on `main` and only surfaced when it
  failed the follow-up PRs. Fixed by #1248.
- **A stale value can hide behind a renamed stage.** #1241's anchor test used
  `?onboarding=power` as an "unknown" value, but `power` had quietly become a real
  onboarding stage — so the test hung rather than failed. Raising the timeout would not
  have fixed it; the root cause was the value, not the clock.
