---
covers:
  - 'fix(server): a retired session id redirects to its live projector instead of splitting it (DOR-1262)'
  - "fix(server): the staged-message receipt reaches a renamed session's stream (DOR-1262)"
---

### Fixed

- A new chat gets its permanent name a moment after you send the first message. Anything still using the name from that first moment — a button inside a reply, a window opened from an old bookmark, or a script talking to the API — used to quietly start a second, empty copy of the chat and cut the live one off mid-answer. Both names now lead to the same chat, so the reply keeps streaming and the click lands where you expect (DOR-1262)
- The receipt that confirms a message was staged now reaches your screen for a chat that has been renamed, instead of going nowhere (DOR-1262)
