---
covers:
  - 'feat(community): track tenant blob ownership'
  - 'fix(community): share blob reservation lease'
---

### Added

- File uploads and exports now record which Community owns their storage before writing bytes, so interrupted work can be cleaned up without touching another Community's files.
