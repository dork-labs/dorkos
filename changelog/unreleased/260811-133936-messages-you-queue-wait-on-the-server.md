---
covers:
  - 'feat(client): the messages you line up wait on the server, so every window sees them (P2.6, DOR-1133)'
---

### Changed

- Messages you type while an agent is working now wait on the server instead of in your
  browser. They survive a page refresh, they show up in every window you have open, and
  any window can reword one, move it earlier, send it next, or take it off the line. A
  message you did not queue yourself is marked as coming from another window, so you can
  tell at a glance which are yours (DOR-1133)
- Nothing you type can be lost on the way to the line: your words stay in the message box
  until they are safely in the queue, so a dropped connection leaves them right where you
  wrote them
