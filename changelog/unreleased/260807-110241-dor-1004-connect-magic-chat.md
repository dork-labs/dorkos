---
covers:
  - 'feat: sign-in lands as a card in the chat and the agent resumes on its own (DOR-1004)'
  - 'fix: a finished sign-in leaves a receipt, and the client stops owning the resume (DOR-1004)'
  - 'fix: the server brings the agent back when a sign-in lands, not the browser (DOR-1004)'
---

### Added

- Ask your agent to connect something — your meeting notes, your issue tracker — and the
  sign-in link now shows up as a card right in the chat, with the plain-English note about
  what DorkOS does with the token sitting above it. No hunting through settings, and no wall
  of text from your agent repeating a link you can already see. Click it, sign in, come back:
  your agent picks the job back up on its own and carries on with what you asked for, without
  announcing that it connected or asking you to say when you are done. It works whether or not
  you left the tab open, so you can sign in on your phone, reload the page, or close the
  window and come back later (DOR-1004).
- The card stays put while you are away signing in, so a tab you open in the meantime still
  shows it — and once the sign-in lands it becomes a short receipt in the conversation saying
  what was connected and how many tools it brought. That receipt is the record: your
  conversation can tell you later what you authorized and when (DOR-1004).
- Adding a server that needs signing in now walks you straight into the sign-in, instead of
  dropping you back at the list to find the new row and press a button (DOR-1004).

### Fixed

- After a successful Test, a server row says "Connected" instead of still asking you to sign
  in — Test is the only thing on the row that actually reaches the server. If the sign-in is
  later lost while the panel is open, the row goes back to asking you to sign in rather than
  staying green (DOR-1004).
- A row that is missing a sign-in no longer sits on "Connecting…" forever with nothing to
  press (DOR-1004).
- A sign-in that does not go through now says so in the chat, tells you the reason the other
  service gave, and offers a Try again button instead of leaving you guessing (DOR-1004).
