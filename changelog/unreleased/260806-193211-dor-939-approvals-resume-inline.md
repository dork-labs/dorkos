---
covers:
  - 'feat(shared): capability approval hold events and inline card part (DOR-939)'
  - 'feat(server): destructive capability approvals hold in-session and resume on approval (DOR-939)'
  - "feat(client): an agent's held capability approval shows inline in the chat (DOR-939)"
---

### Added

- When an agent needs your OK for something it cannot undo, like adding a tool server, it now
  waits for your answer and picks up the moment you approve. The request shows up as a card right
  in the chat, and saying yes there lets the agent keep going without you having to tell it to try
  again. If you step away, nothing is lost: the same request still waits for you in your approvals
  list, and the agent is never left worse off than before (DOR-939)
