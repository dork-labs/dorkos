---
covers:
  - 'fix(server): agents are told how a canvas page talks back to them (DOR-3159)'
---

### Fixed

- Agents now know how a canvas page can send them events and how to answer: routes you allow, button presses that reach the agent, and live values on the page the agent can update. Before, they could only make pages that sat still. (DOR-3159)
