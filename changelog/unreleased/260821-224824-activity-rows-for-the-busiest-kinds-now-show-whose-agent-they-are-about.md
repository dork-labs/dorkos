---
covers:
  - 'fix(server,relay): a finished turn, a stalled session, an unanswered question, and an undelivered message now name their agent (DOR-1408)'
  - "fix(server,client): the escalation relay leg prefers a blocked agent's own chat, pinned by a test — and two comments catch up to what DOR-1408 shipped (DOR-1408 review)"
---

### Fixed

- A finished turn and a message that never arrived now show the agent's own picture in Activity instead of a plain icon. Several finished turns in a row from the same agent also collapse into one line, the same way other busy activity already does (DOR-1408)
- A session that stopped on an error and a question nobody answered are now attributed to the right agent too, though their rows still draw the plain red icon that flags something urgent — that part is unchanged, on purpose. When one of them needs to reach your phone, it now goes out through that agent's own chat instead of whichever chat was used most recently (DOR-1408)
