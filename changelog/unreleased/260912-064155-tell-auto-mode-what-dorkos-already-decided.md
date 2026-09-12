---
covers:
  - 'feat(claude-code): tell auto mode which safety tier a DorkOS tool call already passed'
  - 'feat(observability): count auto-mode stops on DorkOS tools'
---

### Changed

- In auto mode, Claude Code is told which DorkOS safety tier a tool call already passed, so it asks you less often about things that were already decided. It can still ask whenever it wants to. Set `DORKOS_CLASSIFIER_CONTEXT=0` to turn it off.
