---
covers:
  - 'feat(server): a claude-code chat can keep its agent running between messages (P3.10, DOR-1175)'
  - 'test(server,test-utils): hold the persistent pump to the contract it now runs under (P3.10, DOR-1175)'
  - 'fix(server,test-utils): Stop reaches a turn, never a process that is merely warm (DOR-1175 review)'
---

### Added

- Claude Code chats can now keep their agent running between messages. Normally every message
  you send starts the agent up again and shuts it down when the reply is done; with this on, the
  agent stays running in between, so your next message reaches one that is already awake.
  Turn it on with `runtimes.claudeCode.persistentSession`. It ships off, and it applies to the
  next message you send in each chat — nothing you have open changes underneath you. An agent
  that has been sitting idle is shut down for you after a few quiet minutes, and you will not
  notice: your next message picks the conversation up exactly where it left off (DOR-1175)
