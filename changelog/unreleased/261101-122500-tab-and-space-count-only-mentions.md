---
covers:
  - "fix(client): a channel's tab and the Community page count only your mentions (DOR-3593)"
---

### Fixed

- A channel's tab follows the sidebar's rule. New messages make its name bold, and the number counts only your @mentions. A direct message's tab counts every new message, and a muted room's tab stays quiet unless someone mentions you. Before, a busy channel's tab showed every unread message as a number. (DOR-3593)
- A channel's tab, its hover card, the History menu and a channel link no longer read "# #general". The `#` icon is the mark, and the name beside it is just "general". (DOR-3593)
- On a space's own page, a channel with new messages now has a bold name instead of a badge counting everyone's messages. (DOR-3593)
