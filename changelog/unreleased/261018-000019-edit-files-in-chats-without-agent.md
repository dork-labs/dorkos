---
covers:
  - 'fix(canvas): files opened in a chat with no agent can be edited again (DOR-2665)'
  - 'fix(canvas): the file-save notice is one sentence and clears the editor buttons (DOR-2999)'
---

### Fixed

- Files opened in a chat that isn't tied to an agent can be edited and saved again. Before, the edit button stayed off and the canvas said previous saves couldn't be checked. Such a file still saves only inside the folder the chat was working in (DOR-2665)
- When a file in the canvas can't be edited from there at all, it now says so plainly, instead of suggesting a temporary problem (DOR-2665)
- The notice above a file in the canvas no longer hides under the refresh and edit buttons. When previous saves can't be checked, it is one short sentence with a Check again button beside it (DOR-2999)
