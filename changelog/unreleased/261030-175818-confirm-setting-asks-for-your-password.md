---
covers:
  - 'feat(server): Confirm this setting asks "Confirm it''s you" first (DOR-3467)'
  - 'fix(desktop): the "Confirm it''s you" window names the server''s origin on its read too (DOR-3234)'
  - 'fix(server): a confirmed step-up re-checks the owner, and a late answer never ends the wrong sheet (DOR-3234)'
---

### Security

- Confirming a paused connection's setting now asks for your DorkOS password first, so an agent can't confirm it for you. On the Mac app you type it in a small window of its own. Undo still needs nothing (DOR-3467)
