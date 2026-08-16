---
covers:
  - 'feat(client): you can now leave a channel from its menu (DOR-1233)'
  - 'fix(client,server): a room you left says so, #team cannot be left, and leaving can be undone (DOR-1233)'
  - 'fix(client): pin the #team and 1:1-DM leave guards to the facts they guard (DOR-1233)'
---

### Added

- You can now leave a channel or a group conversation from its menu in the sidebar. Pick "Leave," confirm, and you're off the roster right away. You can still read what was said, but you can't post again until you rejoin from that same menu, or undo it from the toast right after leaving. If two agents are in there together, DorkOS asks you to remove one first, so a conversation is never left with nobody around to read it. Your home channel, #team, always keeps you on it, since it's the one place DorkOS itself depends on (DOR-1233)
