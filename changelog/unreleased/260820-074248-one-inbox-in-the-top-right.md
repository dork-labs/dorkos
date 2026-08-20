---
covers:
  - 'feat(client,shared): one Inbox in the top right — things waiting on you stay pinned, everything else sits below with read marks (DOR-1384)'
---

### Added

- There is now one Inbox in the top right, and it replaces the amber "waiting on you" pill. Anything that is genuinely stopped and waiting on a person — a permission an agent wants, a question it asked, a scheduled run it proposed — is still pinned at the top and still turns the marker amber, and you still answer it right there without leaving the page. Below that, in a quieter grey, is everything that happened while you were away: turns that finished, runs that failed, agents that stopped answering, notes an agent left you. Each one carries a dot until you have seen it, clicking one opens the thing it is about, and "Mark all read" clears them in one go. Read marks are kept on your machine rather than in the browser tab, so clearing the marker on your laptop clears it on your phone too. The marker stays out of the way entirely when nothing is waiting and nothing is unread. ⌘⇧Y still jumps straight to whatever needs you.
- Every agent's page now shows the same list for just that agent, under a new "Notifications" row, so you can ask "what has this one been up to?" without reading past everything else. A conversation's "..." menu has a "View notifications" item that opens the Inbox showing only that conversation.

### Changed

- The "Recent activity" group on your home screen now reads from the Inbox instead of working things out for itself. It shows the same three things it always did — runs that failed, messages that could not be delivered, agents that went quiet — but they are now the same rows the Inbox holds, so a thing you have already read on one screen looks read on the other. Links people have shared before still open the same detail panels. A message that could not be delivered now opens the Connections page, which lists them all, instead of a panel that could only find some of them.
