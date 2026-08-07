---
covers:
  - 'feat: sign-in lands as a card in the chat and the agent resumes on its own (DOR-1004)'
  - 'fix: a finished sign-in leaves a receipt, and the client stops owning the resume (DOR-1004)'
  - 'fix: the server brings the agent back when a sign-in lands, not the browser (DOR-1004)'
  - 'fix: the sign-in receipt actually retires, and the resume runs in the right directory (DOR-1004)'
---

### Added

- Ask your agent to connect something, like your meeting notes or your issue tracker, and the
  sign-in link now shows up as a card right there in the chat. Above the link is a plain note
  about what DorkOS does with your sign-in. You do not have to go hunting through settings,
  and your agent no longer repeats a long link you can already see. Click it, sign in, and
  come back. Your agent picks the job back up on its own and carries on with what you asked
  for. It will not announce that it connected, and it will not ask you to tell it when you
  are done (DOR-1004).
- You can sign in however you like and it still works. Close the tab, reload the page, or
  finish on your phone. The agent still gets going again on its own (DOR-1004).
- Once the sign-in lands, the card turns into a short note saying what you connected and how
  many tools it added, so you can see it worked. The note sticks around while your agent gets
  back to work, then the chat moves on. The moment your agent picked the job back up stays in
  your chat and names the server, so you can still find it later (DOR-1004).
- The card stays put while you are away signing in. If you open a new tab in the meantime, it
  shows the card too (DOR-1004).
- Adding a server that needs a sign-in now takes you straight into it. Before, you were
  dropped back at the list and had to find the new row and press a button (DOR-1004).

### Fixed

- After a Test that works, a server row says "Connected" instead of still asking you to sign
  in. Test is the only thing on that row that really reaches the server. If your sign-in is
  later lost while the panel is open, the row goes back to asking you to sign in instead of
  staying green (DOR-1004).
- A row that is missing a sign-in no longer sits on "Connecting…" forever with nothing to
  press (DOR-1004).
- A sign-in that does not go through now says so in the chat. It tells you the reason the
  other service gave, and offers a Try again button, so you are not left guessing (DOR-1004).
