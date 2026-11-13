---
covers:
  - 'fix(server): agents are told up front that your Undo of an approval is final, and that a handed-off room post was passed on, not refused (DOR-4049, DOR-3449)'
---

### Fixed

- Agents now know two things before they act, instead of finding out after. If you undo an access approval an agent gave, it's final, and the agent can't approve that request again. And when an agent's room post is passed to its own seat in that room, the agent knows it went through and doesn't try again. (DOR-4049, DOR-3449)
