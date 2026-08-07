---
covers:
  - 'feat(team): serve one roster of every identity on this install (DOR-971)'
  - "fix(team): close the review's three contract findings on the roster (DOR-971)"
  - 'feat(shared): tie TeamMember fact blocks to kind at parse time'
  - 'docs(api): regenerate API docs for GET /api/team'
---

### Added

- One list of everyone on your install — you and your agents together — behind the new `GET /api/team`. It reads the records DorkOS already keeps instead of making new ones, shows your real name rather than "You", and says which agents are yours. If something can't be read, you still get the rest of the list with a note about what was missing: a roster that can't say your name will still list your agents. The Team page that shows this is coming next (DOR-971).
