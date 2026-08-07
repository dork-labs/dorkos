---
covers:
  - 'feat: sign-in lands as a card in the chat and the agent resumes on its own (DOR-1004)'
---

### Added

- Ask your agent to connect something — your meeting notes, your issue tracker — and the
  sign-in link now shows up as a card right in the chat, with the plain-English note about
  what DorkOS does with the token sitting above it. No hunting through settings, and no wall
  of text from your agent repeating a link you can already see. Click it, sign in, come back:
  your agent picks the job back up on its own and carries on with what you asked for, without
  announcing that it connected or asking you to say when you are done. If the server said how
  many tools it has, the card tells you. The card stays put while you are away signing in, so
  a tab you open in the meantime still shows it (DOR-1004).
- Adding a server that needs signing in now walks you straight into the sign-in, instead of
  dropping you back at the list to find the new row and press a button (DOR-1004).

### Fixed

- After a successful Test, a server row says "Connected" instead of still asking you to sign
  in — Test is the only thing on the row that actually reaches the server (DOR-1004).
- A row that is missing a sign-in no longer sits on "Connecting…" forever with nothing to
  press (DOR-1004).
