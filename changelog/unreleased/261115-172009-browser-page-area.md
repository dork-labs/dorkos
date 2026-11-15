---
covers:
  - 'feat(client): the Agent browser says what is going on where the page would be (DOR-4433)'
  - 'fix(client): the browser choice is out of reach and dimmed while the browser opens (DOR-4433)'
---

### Changed

- When the Agent browser has no page to show, it now says why in one short block in the middle of the panel. That covers not open yet, opening, can't reach the browser, open in another chat, and waiting for you. It replaces the pile of notes that used to sit at the top.
- A new empty page in the Agent browser now says "Type an address or a search above." instead of showing a blank white page.
- Forgetting saved sign-ins while the browser is closed is now one small link.
