# Shared native tool implementation record

DOR-4481 · Codex coordinator `01a1e0c1`

## State

Ready for execution after the actual DOR-2067 delivery prerequisite clears. Implementation progress: **0/28**. The specification and task decomposition have each converged under separate REVIEW.md Stage 1 and Stage 2 review. Proposed ADR `261116-065134` remains unaccepted until implemented evidence supports acceptance.

## Frozen inputs

- Specification SHA256: `1b6116896f35b2854ecd451a0a6863f5dca14d0b9d4169a478c317eaa7afab41`.
- Canonical task JSON SHA256: `cd5882c5cb6c936670b3cb3e9abec81f1d6e12f35c32d1e45a3192256c5521c2`.
- Readable task Markdown SHA256: `3f7d6fc8828ece933c5fb935e03ef9608fd3eee3fe4a7e547363d247666afed5`.
- The JSON owns task definitions and dependencies. This record owns measured progress; no Task API calls or live IDs are invented.

## Workflow and dependencies

All source work uses assigned isolated worktrees, normal hooks and separate agents under REVIEW.md. The configured model bindings are unavailable here; delegated implementation and review use the disclosed gpt-6.1-sol workhorse fallback. Tracker writes use the configured account through the Flow adapter. WIP, agent-slot, PR and heavy-run caps remain coordinator constraints.

DOR-2067 supplies the reviewed full-schema foundation and remains a typed delivery dependency. PR #3836 supplies workspace verification prerequisites and is separately held through its exact-head full and external review gates. Neither dependency is represented as already merged.

## Active phase — 1: Live turn foundation

Generated from the canonical task JSON. No implementation task has passed independent review. The actual Linear description was updated from these canonical tasks and freshly read back: all eight phase-one boxes are pending, outside issue text is preserved, and DOR-2067 remains the typed blocker.

- [ ] **1.1** Define the neutral live-tool turn port
- [ ] **1.2** Resolve live tool facts through exact principal ownership
- [ ] **1.3** Bind Claude live mode and events to its turn owner
- [ ] **1.4** Bind Codex live mode and events to its turn owner
- [ ] **1.5** Bind OpenCode live mode and events to its turn owner
- [ ] **1.6** Bind Doe live mode and events to its turn owner
- [ ] **1.7** Thread live caller and hold context through shared MCP invocation
- [ ] **1.8** Build the actual four-path authenticated tool fixture

## Remaining phases

- Phase 2: approval and spin-off outcome — 0/4.
- Phase 3: core, scheduled work and notes — 0/6.
- Phase 4: team, routing, diagnostics and business tools — 0/7.
- Phase 5: integrated proof and handoff — 0/3.

The structural critical path spans 24 tasks. Adapter tasks 1.3–1.6 may run in parallel only with exclusive adapter ownership after 1.2; support task 2.1 and extraction task 2.2 have disjoint ownership. Shared registry, permission and composition cutovers are serialized.

## Review decisions and required proof

Specification review resolved a native-only target restriction: caller authority stays fixed while legitimate declared cross-agent reads remain available. Decomposition review resolved action-ID consumers outside the tools: each cutover owns all live producers/readers/classifiers, including queued starts, power-granting agent creation and marked-turn routing holds. Their actual producer-side denial/positive and fix-removal controls are required in the same slice.

All 39 baseline hand-tool outcomes remain required. No waiver is accepted. Private connection tools keep their separate audience; original strict input parsing, approval hash/token binding, current authority, canonical home/desk, cancellation and durable event delivery remain constraints. Each domain needs actual production injection/authenticated listener/principal lifecycle and owning effects, with positive subjects and discriminating controls. Scripted SDK/model edges prove those seams; they do not establish live-model behavior.

Latest-main background-work/count semantics, permitted A-to-B targets, supported Claude-account probe targets and warm refresh are part of the frozen acceptance contract. Each migrated hand registration and live action-ID consumer moves atomically; final inventory and docs closeout cannot excuse a temporarily weakened permission path.

## Delivery

Progress requires actual source, measured evidence, separate review, regenerated active-phase tracker checklist with readback, and a checkpoint. Partial pull requests use a non-closing reference to DOR-4481 and keep its identifier out of a closing title/branch. Final verification, Security, QA, required CI, actual queue merge and worktree cleanup remain delivery gates. Proposed ADR acceptance is deferred until its described pattern is present and verified.
