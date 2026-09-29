---
covers:
  - 'feat(extensions): run the newest copy of an extension in every project, and trust a source once (DOR-2527)'
---

### Changed

- When the same extension is installed in several projects, DorkOS now runs the newest copy everywhere instead of whichever project it opened first. You say yes to it once, not once per project (DOR-2527)

### Added

- Right after you turn on an extension, the inbox can offer "Next time, trust everything from dork-labs/marketplace?". Say yes and extensions DorkOS installs from there turn on without asking. Only you can do this, and you can undo it in Settings → Extensions → Trusted sources (DOR-2527)
