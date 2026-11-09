---
covers:
  - "fix(server): DorkOS's own protected files are refused by the canvas, attachments and agent launches (DOR-4060)"
---

### Fixed

- **DorkOS's own private files stay private.** These include its sign-in key, its settings and its saved secrets. The canvas, room attachments and new chats an agent starts now refuse them at every level, with nothing to approve.
- **An approval card for reading a canvas document names the file it reads.**
