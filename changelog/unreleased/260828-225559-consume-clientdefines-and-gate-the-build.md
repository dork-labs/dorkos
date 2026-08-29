---
covers:
  - 'fix(obsidian-plugin): consume clientDefines() and gate the build against unsubstituted defines'
---

### Fixed

- The Obsidian plugin's build now checks that every version number it stamps
  into the app actually made it into the bundle. This catches, before the
  plugin ever reaches a vault, the same kind of bug that once left the
  desktop app stuck on a black screen (DOR-1472)
