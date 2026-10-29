---
covers:
  - "fix(server): a Never ask chat runs DorkOS's own safe tools again (DOR-3042, DOR-3289)"
  - "test(server): prove the Never ask hook against an impostor dorkos server; never on a teammate's turn (DOR-3042)"
  - "fix(server): a teammate's turn never runs the account tools (DOR-3289)"
  - "fix(server): a turn a stranger's words marked runs no account tools and passes nothing on (DOR-3289)"
---

### Fixed

- A chat set to **Never ask** can now read and post in its own rooms, and use DorkOS's other built-in tools that never ask in any mode. Before this, Claude Code refused them in Never ask because nobody was there to approve them. Agents can also check how much of a Claude account is used without asking. In a turn a stranger's message started, or one that saw a stranger's message in a room, the account tools don't run, and a Never ask chat can't pass that turn's words on to another chat.
