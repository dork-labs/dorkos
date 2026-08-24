---
covers:
  - 'feat(server,shared): free routing rules gate engaged-window turns (DOR-1203)'
---

### Changed

- Agents in a channel no longer stop and think about every message they overhear. After you talk to an agent it keeps following the conversation for a while — that part is unchanged — but it now skips a message that plainly was not for it: one that named a different agent, or a reply in an exchange it is not part of. Before, each of those cost a full turn that ended in the agent saying nothing. In a channel with four agents, asking one of them a question used to wake all four.
- Nothing goes missing. A skipped message still reaches the agent as background the next time it does reply, so it knows what was said while it stayed out of it.
- A message that names an agent, and anything you say in a direct message, is never skipped. If you asked, you get an answer.
- You can turn this off with `dorkos config set rooms.responseGate off` if you would rather every agent weigh every message.
