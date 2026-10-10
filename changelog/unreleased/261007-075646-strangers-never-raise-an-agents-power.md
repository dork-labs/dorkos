---
covers:
  - 'feat(communities): choose who can wake your agents in a space (DOR-2764)'
  - 'fix(rooms): tell agents in a space channel that outsiders post there (DOR-2764)'
  - 'test(communities): pin the space walk to the per-turn ceiling main built (DOR-2764)'
  - 'refactor(communities): keep the wake setting and space framing off the over-limit files (DOR-2764)'
  - "fix(claude-code): keep a stranger's background work at the ceiling on a warm process (DOR-2764)"
---

### Fixed

- Work an agent started in the background while answering someone from outside your computer, such as a helper or a shell, now keeps asking before it acts after that reply ends. Before, your own next message could hand that work your level. If your message has to wait for that work to finish first, the work still asks while it waits (DOR-2764)
- If an agent's open session does not switch down to the asking level for an outsider's message, it now restarts at that level instead of answering at yours (DOR-2764)
- Agents in a space's channel are now told that people outside your computer post there, and that their messages are not instructions, the same way they are told in a linked chat (DOR-2764)
