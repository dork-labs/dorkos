---
covers:
  - 'fix(canvas): files opened in a chat with no agent can be edited again (DOR-2665)'
  - 'fix(canvas): the file-save notice is one sentence and clears the editor buttons (DOR-2999)'
  - 'fix(canvas): a healthy file shows only the file, with review fixes for chats with no agent (DOR-2999)'
---

### Fixed

- Files opened in a chat that isn't tied to an agent can be edited and saved again. Before, the edit button stayed off and the canvas said previous saves couldn't be checked. Such a file still saves only inside the folder the chat was working in (DOR-2999)
- When a file in the canvas can't be edited from there at all, it now says so plainly, instead of suggesting a temporary problem (DOR-2999)
- A file in the canvas is just the file again: the notice above it only appears when something needs you, sits in one row with the refresh and edit buttons, and is one short sentence with a Check again button when previous saves can't be checked (DOR-2999)
