---
covers:
  - 'fix(chat): a chat waiting on an approval, a question or a sign-in shows Stop (DOR-3202)'
  - "fix(chat): the card's Stop never answers the card, and a card nothing holds no longer keeps a dead Stop (DOR-3202)"
  - "fix(chat): the card's Stop label sits beside its icon, and the changelog says which turns show Stop (DOR-3202)"
---

### Fixed

- A chat waiting for your answer on an approval, a question or a sign-in now shows Stop when you started the turn, including after you reload the page. Stop takes the card away and ends the turn, so your next message starts a new one. Messages you queued come back to the message box, as they do for any Stop. When the agent started the turn itself, for example a helper asking after its reply or the agent picking up work on its own, the card offers Don't allow and no Stop for now (DOR-3202)
- When you stop a turn that is waiting on a card, the step the card asked about shows as not run instead of still running (DOR-3202)
- A card left over from a turn that had already ended no longer keeps a Stop that does nothing. Stop clears it (DOR-3202)
