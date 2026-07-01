# Plans Index

`plans/` holds implementation plans, design explorations, and findings reports:
the working thinking that precedes or accompanies a change. It sits between
`research/` (open-ended investigation, no commitment to build) and `specs/` (the
validated, manifest-tracked contract that work is executed against). A plan is a
point-in-time artifact; once its work ships, it becomes a historical record.

Completed and superseded plans are moved to [`plans/archive/`](archive/) to keep
this directory focused on live work. Plans that are still cited as the current
design of record (notably the relay and mesh design docs and the `*-specs/`
subdirs, which implemented specs link to for provenance) are kept here and marked
**Provenance** rather than archived, so those inbound links keep resolving. Moving
that relay/mesh archaeology is a separate, deliberate follow-up because it would
require rewriting provenance links across roughly twenty implemented specs.

## Status

`Active` = live roadmap or unfinished work. `Provenance` = complete or superseded
but still cited as the design of record by shipped specs, so it stays in place
pending a deliberate reference migration. `Archived` = completed or superseded and
moved to `plans/archive/`.

| Plan                                                                                                             | Status     | Date       | Note                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ---------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `agent-harness-portability-roadmap.md`                                                                           | Active     | 2026-06-27 | Multi-harness portability roadmap (Claude / Codex)                                                       |
| `flow-loop-system-revision.md`                                                                                   | Active     | 2026-06-26 | Ongoing `/flow` loop system revision                                                                     |
| `2026-02-24-relay-design.md`                                                                                     | Provenance | 2026-02-24 | Relay design of record; cited by ~9 implemented relay specs as provenance. Migrate refs before archiving |
| `2026-02-24-mesh-design.md`                                                                                      | Provenance | 2026-02-24 | Mesh design doc; superseded by implemented mesh specs but still linked. Migrate refs before archiving    |
| `2026-02-24-litepaper-review.md`                                                                                 | Provenance | 2026-02-24 | Litepaper review; open OQs cited by relay specs. Actionable items resolved, vision OQs remain            |
| `2026-02-27-relay-conversation-view-design.md`                                                                   | Provenance | 2026-02-27 | Relay conversation-view design; shipped, but paired plan links to it                                     |
| `2026-02-27-relay-conversation-view-plan.md`                                                                     | Provenance | 2026-02-27 | Implementation plan for the above; shipped (ConversationRow exists)                                      |
| `2026-02-28-telegram-adapter-investigation.md`                                                                   | Provenance | 2026-02-28 | Telegram adapter fixes shipped; cited by implemented `adapter-agent-routing` spec                        |
| `2026-03-05-chat-self-test-findings.md`                                                                          | Provenance | 2026-03-05 | Findings report; consumed by implemented `chat-streaming-session-reliability` spec                       |
| `2026-03-06-chat-self-test-findings.md`                                                                          | Provenance | 2026-03-06 | Findings report; cited by implemented relay-SSE fix specs                                                |
| `2026-03-06-chat-self-test-findings-2.md`                                                                        | Provenance | 2026-03-06 | Findings report (run 2); cited by implemented relay-SSE fix specs                                        |
| `2026-03-06-claude-code-adapter-audit.md`                                                                        | Provenance | 2026-03-06 | Adapter-coupling audit; cited by implemented `codex-runtime-adapter-prework` spec                        |
| `mesh-specs/`                                                                                                    | Provenance | 2026-04-10 | Pre-`specs/` mesh planning docs; superseded by implemented mesh specs that link back to them             |
| `relay-specs/`                                                                                                   | Provenance | 2026-04-10 | Pre-`specs/` relay planning docs; superseded by implemented relay specs that link back to them           |
| [`archive/2026-02-18-automatic-adr-extraction-design.md`](archive/2026-02-18-automatic-adr-extraction-design.md) | Archived   | 2026-02-18 | Auto ADR extraction shipped (`/adr:curate`, `adr-drift-check.mjs`)                                       |
| [`archive/2026-02-27-homepage-design-review.md`](archive/2026-02-27-homepage-design-review.md)                   | Archived   | 2026-02-27 | Homepage creative review; changes executed into `apps/site/`                                             |
| [`archive/2026-02-27-homepage-rebuild.md`](archive/2026-02-27-homepage-rebuild.md)                               | Archived   | 2026-02-27 | Narrative homepage rebuild shipped to `apps/site/`                                                       |
| [`archive/2026-02-27-version-update-ux-design.md`](archive/2026-02-27-version-update-ux-design.md)               | Archived   | 2026-02-27 | Version/update UX shipped; superseded by `SidebarUpgradeCard`                                            |
| [`archive/2026-03-10-agent-selector-redesign.md`](archive/2026-03-10-agent-selector-redesign.md)                 | Archived   | 2026-03-10 | `AgentPicker` shipped; old `AgentCombobox` removed                                                       |
| [`archive/2026-03-25-resolve-agent-visual-refactor.md`](archive/2026-03-25-resolve-agent-visual-refactor.md)     | Archived   | 2026-03-25 | `resolve-agent-visual.ts` + test shipped exactly as planned                                              |
