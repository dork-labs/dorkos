---
covers:
  - 'fix(server): a helper cut off by the runtime no longer convinces your agent you said no (DOR-1150)'
---

### Fixed

- When the runtime cut off a helper the agent had running, the helper often
  reported back that you had declined something or blocked it from saving. The
  agent believed the helper and gave up on that work. DorkOS now tells the agent
  what actually happened — the runtime stopped it, you did not — and to redo the
  work instead of taking the helper's word for it.
