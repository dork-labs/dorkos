---
covers:
  - 'fix(client): things you write in show up in Today, whatever door you came through (DOR-1156)'
  - "fix(client,ci): the queue flush is the agent's moment, not yours (DOR-1156)"
---

### Fixed

- Sending a message now puts that conversation in Today. Before, only clicking a
  row in the sidebar counted — so you could write a long prompt to an agent,
  open something else, and find the conversation gone from the list (DOR-1156)
- Posting in a channel or a DM does the same, including the one on your home
  page. Home is the #team room, and until now writing there left no trace in
  Today (DOR-1156)
- Today also remembers conversations you reach from the other doors: the "who's
  working" strip at the top of home, the "Jump back in" panel over the composer,
  the needs-attention list, and Open a session from someone's profile (DOR-1156)
