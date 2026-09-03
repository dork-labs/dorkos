---
covers:
  - "fix(client,e2e): an agent can read its preview's console in the browser app (DOR-1305)"
---

### Fixed

- Fixed a bug where an agent could not see anything from a preview it opened in the browser app: its console messages, network requests, and screenshots never reached the conversation, so asking about a page's errors came back empty. It only worked inside Obsidian (DOR-1305)
- Fixed a bug where switching conversations while a preview was busy could file the last moment of its console under whichever conversation you had just opened (DOR-1305)
