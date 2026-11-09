---
covers:
  - 'fix(settings): explain unavailable scheduled waking (DOR-4064)'
  - 'fix(settings): shorten the sleep hint to the 15-word cap (DOR-4064)'
  - 'fix(settings): say keep-awake does not cover pending scheduled tasks (DOR-4064)'
  - 'fix(settings): keep the stake clause in the scheduled-wake refusal (DOR-4064)'
---

### Fixed

- Settings and agents now say plainly that scheduled tasks only run while the computer is awake. DorkOS can't wake it for them yet.
