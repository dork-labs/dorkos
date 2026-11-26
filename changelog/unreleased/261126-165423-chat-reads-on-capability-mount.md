---
covers:
  - 'feat(server): A1, the chat reads move onto the capability mount (DOR-4978)'
---

### Changed

- Two chat reads are now listed in the API document: which program runs a chat, and the settings saved for a chat. The first was missing from the document before. Who may read each chat is the same as before.
- When an agent asks for one of these two about a chat it may not read, the error now also carries a short explanation that repeats its title. The status and code are the same.
- In the API document, the settings read has a new operation name: `sessions.getSettings` is now `sessions.get_settings`. A generated client needs regenerating.
