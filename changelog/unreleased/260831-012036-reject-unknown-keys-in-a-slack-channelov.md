---
covers:
  - 'fix(shared): reject unknown keys in a Slack channelOverrides entry instead of silently emptying it (DOR-655)'
---

### Fixed

- Saving a Slack per-channel override with a mistyped setting name now shows an error naming the problem, instead of silently saving an empty rule
