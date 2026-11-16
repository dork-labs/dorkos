---
covers:
  - 'feat: show background work that outlives its turn on the session status and in session reads (DOR-2065)'
  - 'fix(chat): the background strip says its count once, fits a phone, and a stop on a finished task drops its row (DOR-2065)'
---

### Changed

- A chat now shows the work its agent left running, after the agent stops talking. Helpers, background commands and watchers like Monitors stay in the task strip above the message box, even after the chat reloads. Each one shows its own name and can be stopped.
- The status line counts all of that work, not just helper agents. It now says "background tasks" instead of "subagents".
- Agents can see it too. The running chats list shows a chat whose turn ended with work still going, and the session count for an agent says how many of its chats have work still running.
