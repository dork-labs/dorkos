---
covers:
  - 'feat(team): serve one roster of every identity on this install (DOR-971)'
---

### Added

- One list of everyone on your install — you and your agents together — behind the new `GET /api/team`. It reads the records DorkOS already keeps instead of making new ones, shows your real name rather than "You", and says which agents are yours. If the agent registry can't be read, you still get the rest of the list with a note about what was missing. The Team page that shows this is coming next (DOR-971).
