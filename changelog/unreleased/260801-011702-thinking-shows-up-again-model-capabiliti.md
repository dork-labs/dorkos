---
covers:
  - 'fix(runtime): thinking shows up again — model capabilities stop getting lost on the way to the cache'
---

### Fixed

- The agent's thinking shows up again. It streams in while the agent is thinking and stays in the conversation afterward — a lost capability flag had been leaving every thinking block empty.

### Changed

- Auto permission mode works again on models that support it. The same lost flag had been quietly running "auto" sessions in the default permission mode and hiding "auto" from the permission picker; both now behave as selected.
- The fast-mode toggle appears for models that support it — the flag that showed it was lost the same way.
