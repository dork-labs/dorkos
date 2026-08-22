---
covers:
  - 'feat(client): channels wear the one bar — the room masthead is gone (DOR-1402)'
  - "fix(client): keep the playground's quiet room bars quiet (DOR-1402)"
  - 'fix(client,e2e): answer the R1 review — truncation order, the phone bar, and the ids that moved (DOR-1402)'
---

### Changed

- A channel no longer names itself twice. The room name, what it is about, and everything happening in it now live in the single header row at the top, so the conversation starts a row higher (DOR-1402)
- The header of a room now shows when agents are working in it and gives you a Stop button to halt them all. Both hold their place while the room is quiet, so nothing shifts under your cursor when an agent starts (DOR-1402)
- On a phone that pair is replaced by a small green dot on the head count, and the room's name gets the space back — you stop agents from the line above the message box, which is on screen whenever something is running (DOR-1402)
- When the header runs out of room, the topic shortens and disappears before the room's name gives up any space. The name only shortens when nothing else is left, and hovering either one shows the full text (DOR-1402)
- Home shows that same working count and Stop button again, next to the head count for your #team room (DOR-1402)
- Press the head count in a room's header to see who is in it and add more (DOR-1402)
- Your #team room now opens in one place. Pressing #team in the sidebar takes you Home, and old links to it land there too, with any open thread still open. The #team row stays highlighted while you are there (DOR-1402)

### Fixed

- Opening a link to a conversation now shows the room loading instead of a blank page while DorkOS works out which room it is (DOR-1402)
