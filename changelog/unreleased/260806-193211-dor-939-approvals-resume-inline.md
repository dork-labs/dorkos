---
covers:
  - 'feat(shared): capability approval hold events and inline card part (DOR-939)'
  - 'feat(server): destructive capability approvals hold in-session and resume on approval (DOR-939)'
  - "feat(client): an agent's held capability approval shows inline in the chat (DOR-939)"
  - 'fix(server): capability-hold normalizer fallbacks fail toward keeping the stall-pause + round-trip test (DOR-939)'
  - 'fix(client): route capability_approval_required events to the inline approval card (DOR-963)'
---

### Added

- When an agent needs your OK for something it cannot undo, like adding a tool server, it now
  waits for your answer and picks up the moment you approve. The request shows up as a card right
  in the chat, and saying yes there lets the agent keep going without you having to tell it to try
  again. The agent waits about ten minutes; if you take longer it stops waiting and says so, and
  the request is still there in your Approvals list — answer it, then tell the agent to try again,
  exactly as before this existed (DOR-939)
