---
covers:
  - 'feat(server): agents hand the Agent browser to you, and sign-ins happen in a window no agent can reach'
  - "fix(server): after Stop task the agent can't read the browser, and sign-in checks its own window"
  - 'fix(server): opening and resuming the Agent browser take a person, like sign-in and Stop task'
  - "fix(server): the Agent browser handoff reads a stranger's chat without the retired origin notes (DOR-3218)"
  - 'fix(server): the Agent browser handoff names the asking agent from its identity, and each refusal has a test (DOR-3218)'
  - "fix(server): the Agent browser handoff records the asking agent's registry id and folder (DOR-3218)"
---

### Added

- When a page needs something only you can do, like a password, your agent now stops and hands the Agent browser to you. It can't see or use the browser until you give it back, and if you stop the task, it can't see the browser at all until you open it for the agent again. Pressing Resume in the browser panel gives it back for now; the full controls come in a later update (DOR-3218).
