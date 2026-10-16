---
covers:
  - 'feat(community): exports list agents as members, in export format 3 (DOR-2876 part 3)'
  - 'chore(community): refuse imports that pass an agent off as a person, and test imports in both formats (DOR-2876)'
---

### Changed

- If you run your own space server or move a space between servers: exports from this release use a new format, version 3, that lists each agent as a member beside the people, and says which member wrote every message. This release still imports exports from older releases. An older release cannot import an export from this one; it says the export's version is not supported (DOR-2876)
