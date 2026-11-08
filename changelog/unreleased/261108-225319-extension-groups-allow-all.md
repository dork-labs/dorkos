---
covers:
  - "wip(extensions): allow a plugin's extensions as one set, each with its own digest (DOR-3583)"
  - "feat(extensions): a plugin's extensions are one row, and Allow all asks once (DOR-3583)"
---

### Added

- Extensions that came in one plugin now show as one row in Settings → Extensions, with one switch for the ones you already allowed. Open it to see each one and turn them on or off on their own. (DOR-3583)
- When a plugin's extensions are waiting, one card asks about all of them: what they can do together, then each one. **Allow all** still allows each one on its own, with its own check of its files. If one can't be allowed, the card says which. ⌘K offers "Review … extensions" to open it. (DOR-3583)
