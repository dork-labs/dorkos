---
covers:
  - 'fix(canvas): files opened in a chat with no agent can be edited again (DOR-2665)'
---

### Fixed

- Files opened in a chat that isn't tied to an agent can be edited and saved again. Before, the edit button stayed off and the canvas said previous saves couldn't be checked. Such a file still saves only inside the folder the chat was working in (DOR-2665)
- When a file in the canvas can't be edited from there at all, it now says so plainly, instead of suggesting a temporary problem (DOR-2665)
