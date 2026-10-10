---
covers:
  - "refactor(session): read a chat's status facts before ranking them (DOR-2820)"
  - 'feat(tabs): every tab says who or where, and whether it needs you (DOR-2820)'
  - 'feat(tabs): the window title names the page you are on (DOR-2820)'
  - 'fix(tabs): keep Paused and the prompt list right, and the shell quiet (DOR-2820)'
  - "refactor(playground): give the tab strip's sections their own file (DOR-2820)"
  - 'fix(tabs): a chat with no title yet no longer crashes the window title (DOR-2820)'
---

### Changed

- Every tab in the desktop app now says who or where it is, and whether it needs you. A chat tab reads "Scout · Fix the login bug". A channel shows its unread count. Home counts what is waiting on you, and Team shows how many agents are working (DOR-2820)
- A tab shows one status at a time: needs you, failed, paused (out of usage), working, or new. Hover a tab to see its full name, what it is waiting for, and when it was last active (DOR-2820)
- Two tabs open on the same agent now lead with the chat title, so you can tell them apart (DOR-2820)
- The window title names the page you are on, the same way its tab does. Pages that are not chats no longer show the last agent you picked. A bell shows on every page while anything waits on you (DOR-2820)
