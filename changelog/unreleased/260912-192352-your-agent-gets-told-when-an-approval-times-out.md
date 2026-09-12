---
covers:
  - 'fix(server): an approval nobody answers now ends on its own, and says so (DOR-1932)'
  - 'fix(server): a held call says the approval died, instead of pointing at a dead token (DOR-1932)'
---

### Fixed

- Your agent gets told when an approval times out. When an agent asks to do something that needs your
  sign-off and you never get to it, the request quietly stops being valid after two hours — but until
  now nothing said so. The agent was left waiting on an answer that could no longer come, and you had
  to go and tell it yourself. Now the request closes itself on time and the agent is told, in its own
  words: nobody answered, the request is dead, ask again if it still matters. You get no extra ping —
  it was not your action to be reminded about, and the request had already disappeared from your
  approvals list on its own.
