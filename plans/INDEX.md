# Plans Index

`plans/` holds implementation plans, design explorations and findings reports: the thinking between `research/` (open questions, no commitment) and `specs/` (the tracked contract work is built against). A plan is a point-in-time record. When its work ships or is dropped, it is deleted, or moved to [`archive/`](archive/) if specs, ADRs or code still cite it.

## Current

| Plan                                                                         | What it is                                                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [`2026-10-vision-reset.md`](2026-10-vision-reset.md)                         | The agreed 2026-10 vision brief. Record only: canon is the north-star set in `meta/`                                    |
| [`2026-10-vision-reset-decisions.md`](2026-10-vision-reset-decisions.md)     | The decisions behind that brief, with the founder's reasons                                                             |
| [`architecture-improvement-roadmap.md`](architecture-improvement-roadmap.md) | Architecture rationale and bounded handoffs (DOR-2344), refreshed for the October vision reset; Linear owns live status |
| [`canvas-browser-delivery-20261001.md`](canvas-browser-delivery-20261001.md) | Canvas and browser delivery work, still running                                                                         |
| [`ci-steward-plan.md`](ci-steward-plan.md)                                   | CI Steward design of record; workflows, hooks and ledger entries cite it                                                |
| [`ci-steward-status.md`](ci-steward-status.md)                               | CI Steward handoff snapshot (2026-09-19); an error message in `packages/ci-steward` cites it                            |
| [`community-next-phase.md`](community-next-phase.md)                         | Brief for the open community projects                                                                                   |
| [`harness-sync-test-plan.md`](harness-sync-test-plan.md)                     | Harness Sync test plan, still edited                                                                                    |
| [`identity-micro-interactions/`](identity-micro-interactions/design-spec.md) | Identity motion design spec; client code and tests treat it as binding                                                  |
| [`language-ia-simplification.md`](language-ia-simplification.md)             | The vocabulary programme behind the vocab gate's waves                                                                  |
| [`ui-ux-audit-202609/`](ui-ux-audit-202609/00-charter.md)                    | The September UI audit (done). Kept in place: `audits/` and the `auditing-ui` skill's reference scripts point at it     |

## Archive

Done or superseded, kept because something still cites it: the Feb and March 2026 Relay, Mesh and chat findings and designs (with `mesh-specs/` and `relay-specs/`), the litepaper review, the Claude Code adapter audit, the agent-harness portability roadmap, the community authority evidence, the composer identity handoff, the desktop resilience programme, the flow loop revision, the generative UI programme, the room turn-limits overhaul, the Shapes programme, and the ADR auto-extraction design. Browse [`archive/`](archive/).

## Deleted in the 2026-10 sweep

Restore from git history if needed: the relay conversation-view implementation plan (shipped), the UI audit codification plan (it became the `auditing-ui` skill and `audits/`), and five archived Feb and March 2026 plans nothing cited (homepage design review, homepage rebuild, version-update UX, agent selector redesign, agent visual refactor).
