---
covers:
  - 'feat(server): Confirm this setting asks "Confirm it''s you" first (DOR-3467)'
  - 'fix(desktop): the "Confirm it''s you" window names the server''s origin on its read too (DOR-3234)'
  - 'fix(server): a confirmed step-up re-checks the owner, and a late answer never ends the wrong sheet (DOR-3234)'
  - 'fix(server): adding, saving or testing a connection with your own setting asks "Confirm it''s you" (DOR-3234)'
  - 'chore(server): step-up is off while a loaded mini app is in an agent''s folder or changed (DOR-3234)'
  - 'feat(client): Settings → Extensions says which mini app keeps "Confirm it''s you" off, and fixes it (DOR-3234)'
---

### Security

- Confirming a paused connection's setting now asks for your DorkOS password first, so an agent can't confirm it for you. So does adding, saving or testing a connection that uses one of your own `env:` or `keychain:` settings. On the Mac app you type it in a small window of its own. Undo still needs nothing (DOR-3467)
- While a loaded mini app sits in an agent's folder, or has changed since you approved it, you can't confirm anything this way, because that mini app could fake the password sheet. Settings → Extensions names it, with a button to move it out or turn it off (DOR-3234)
