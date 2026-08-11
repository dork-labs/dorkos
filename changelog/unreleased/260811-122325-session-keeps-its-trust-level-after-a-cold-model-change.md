---
covers:
  - 'fix(server): a session keeps its trust level after a cold model change (DOR-1151)'
---

### Fixed

- Resume a session after a restart and change only its model, effort, or
  title, and it now keeps the trust level you gave it. Doing this used to
  quietly drop the session back to the default "ask before every action"
  mode — the sidebar and session settings kept showing your real choice, but
  the agent was actually running with less trust than you'd granted it,
  until you re-toggled the dial.
