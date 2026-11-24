---
covers:
  - "fix(shared): text agents read drops formatting characters people can't see (DOR-5133)"
  - 'fix(shared): agents read joiners, selectors and control characters only where people see them (DOR-5133)'
---

### Fixed

- Text agents read in rooms and chats now leaves out formatting characters people can't see on screen. Emoji, keycaps, emoji families, flags and Persian and Indian scripts read as they always did (DOR-5133).
- When an agent reads a code file pinned to a room's canvas, the code now comes back as written, apart from characters that draw nothing (DOR-5133).
