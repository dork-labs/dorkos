---
covers:
  - 'feat(server): A1, the chat reads move onto the capability mount (DOR-4978)'
---

### Changed

- Three chat reads are now listed in the API document: which program runs a chat, the settings saved for a chat, and one document on a chat's canvas. The first was missing from the document before. Who may read each chat is the same as before.
- When an agent asks for one of these three about a chat it may not read, the error now also carries a short explanation that repeats its title. The status and code are the same.
- In the API document, two of these reads have new operation names: `sessions.getSettings` is now `sessions.get_settings`, and `sessions.getCanvas` is now `sessions.get_canvas_document`. A generated client needs regenerating.
