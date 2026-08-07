---
covers:
  - 'feat(server): a dead sign-in flips the row back and puts the card where you hit it (DOR-981)'
  - 'fix(server): check the server itself before deciding a sign-in is dead (DOR-981)'
---

### Fixed

- If a sign-in stops working in the middle of a conversation — you took the app's access away,
  or the other service dropped it — the sign-in card now shows up right there in the chat, and
  the row goes back to saying "Needs sign-in". Before, DorkOS kept quietly sending a key the
  other service had stopped accepting: your agent's tools failed, the row still said
  "Connected", and nothing told you the two were the same problem. Before deciding anything,
  DorkOS checks with the server itself and then tries once to renew the sign-in, so a brief
  hiccup — or a sign-in you just finished — never signs you out of anything. If the card was
  already up and the server starts working again, the card retires itself. The card appears on
  its own, with no extra chatter from your agent (DOR-981).
- If you sign in and DorkOS restarts while you are still in your browser, your agent now picks
  the work back up in the right folder. It used to start again in the wrong place and quietly
  do nothing (DOR-981).
