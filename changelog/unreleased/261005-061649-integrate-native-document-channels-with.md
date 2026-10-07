---
covers:
  - 'refactor(canvas): group document channel modules'
  - 'feat(canvas): integrate native document channels with editor and runtime'
  - 'fix: resolve Room regression setup and native fixture lint failures'
  - 'fix(runtime): retain private Claude session owner'
  - 'fix(e2e): compose original Room HTTP writer services'
  - 'fix(canvas): deliver document events to approved agents'
  - 'fix(canvas): preserve newer drafts and historical action attribution'
  - 'fix: retire OpenCode stream liveness timer after race'
  - 'fix(rooms): preserve native launch errors and late canonical ownership'
  - 'fix(test): match installed SDK reload agent response'
  - 'fix: preserve native room fixtures and retire owned worktree ancestry'
  - 'fix: generate unclaimed Room batch queue index migration'
  - 'fix: preserve native fixture typing and unclaimed Room batch queue'
  - 'fix: restore room reader refusals and verify native fixture custody'
  - 'fix(canvas): retain original native HTTP refusal and manifest causes'
  - 'fix(server): repair native cleanup and preserve genuine fixture authority'
  - 'fix(canvas): preserve grant authority across canonical moves'
  - 'fix(canvas): retain original relay failure through shutdown'
  - 'fix(runtime): cancel original document room reads during shutdown'
  - 'fix(canvas): retain earliest relay failure during concurrent shutdown'
  - 'fix(runtime): correct document shutdown typing'
  - 'fix(test): join original Codex retirement once'
---

### Added

- Save document interactions durably and deliver them to approved agents, with replies linked to the original interaction
- Keep accepted interactions waiting for delivery through a restart
- Update Markdown checkboxes in the existing editor after the write is confirmed

### Fixed

- Stop active document replies cleanly when a model stream goes silent
