---
covers:
  - 'fix(chat): a chat waiting on an approval, a question or a sign-in shows Stop (DOR-3202)'
  - "fix(chat): the card's Stop never answers the card, and a card nothing holds no longer keeps a dead Stop (DOR-3202)"
---

### Fixed

- A chat waiting for your answer on an approval, a question or a sign-in now shows Stop, including after you reload the page. Stop takes the card away and ends the turn, so your next message starts a new one. Messages you queued come back to the message box, as they do for any Stop (DOR-3202)
- A card left over from a turn that had already ended no longer keeps a Stop that does nothing. Stop clears it, and the stopped step no longer shows as still running (DOR-3202)
