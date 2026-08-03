---
covers:
  - 'fix(client): a session row stops hiding a bypass behind a stale answer (DOR-496)'
---

### Fixed

- A session that switched to a permissions-bypassing mode somewhere else — another window, a scheduled task — now shows its warning icon in the session list right away. Sessions you had opened at some point kept showing the mode they had back then, so the one session you most needed to notice was the one that looked ordinary.
