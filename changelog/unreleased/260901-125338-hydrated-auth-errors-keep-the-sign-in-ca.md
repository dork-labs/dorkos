---
covers:
  - 'fix(server,client): hydrated auth errors keep the sign-in card (DOR-1649)'
---

### Fixed

- Reopen a chat that stopped because your sign-in ran out, and you now get the same "Sign in again" card you saw at the time, with the button that fixes it. Before, reloading turned that failure into a line that looked like your agent had said it (DOR-1649)
- Other stop notices from Claude, such as hitting a usage limit, come back the same way: as a notice you can read, not as words your agent said (DOR-1649)
- Search stops filing those notices as things your agent said. This applies to conversations indexed from now on; notices already in your search index stay there until you delete it, which rebuilds from scratch (DOR-1649)
