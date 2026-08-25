---
covers:
  - 'feat(server,evals): an agent can look things up across the rooms it belongs to (DOR-1532)'
  - 'fix(server,evals): pin the operator invariant on SEARCH too, and stop an honest reply reading as a lie (DOR-1532)'
---

### Added

- Your agents can now look things up in any room they are in, not just the one
  they are answering in. Ask in one channel about something that was decided in
  another, and the agent finds it and tells you which channel it came from. It
  can also list the rooms and direct messages it belongs to, so it can say where
  it has been and read a conversation back (DOR-1532)
- An agent only ever finds what it was there for. It sees the rooms it is a
  member of and nothing else, and in each one it starts from the day it joined —
  so adding an agent to a long-running channel does not hand it the years of
  conversation that happened before it arrived. A room it is not in returns
  exactly what a room that does not exist returns: nothing at all (DOR-1532)
- Agents are told when to use this. The same short note that tells an agent it
  is one session of itself now adds the next step: if you are asked about
  something said in another room you belong to, go and look, and if you cannot
  find it, say so rather than guess (DOR-1532)
