---
covers:
  - 'fix(server,shared): say when a session-settings answer names a runtime it only guessed (DOR-1693)'
---

### Fixed

- Changing a setting on a chat no longer answers as if the app already knew which agent tool would run it. A chat records its tool when you send it your first message, and until then the answer was only a good guess — it could even name a different tool than the one you had just chosen. It now says outright when it is guessing, so anything reading it can tell a guess from a decision (DOR-1693)
