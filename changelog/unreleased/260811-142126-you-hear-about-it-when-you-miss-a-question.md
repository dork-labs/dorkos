---
covers:
  - 'fix(server): tell the operator when an unanswered prompt expires (DOR-1158)'
  - 'fix(server): address review findings on the timeout-notice fix (DOR-1158)'
---

### Fixed

- When the agent asked you something — a question, a permission to run a tool,
  or a sign-in prompt from a connected server — and you were away for 10
  minutes, it used to give up in total silence. The card vanished, the agent
  was told you'd said no, and nothing in the chat said what happened. Now the
  chat tells you: what it asked, and that it moved on without an answer.
