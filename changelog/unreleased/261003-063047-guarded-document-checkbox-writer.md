---
covers:
  - 'feat(canvas): add guarded document checkbox writer'
---

### Added

- Add server safeguards for approved document checkbox changes. They reject stale file versions and keep each operation from changing the file twice.
- Hold uncertain file changes for review instead of automatically repeating them.
- This adds server support; editor controls and other file-writing tools are not connected to it yet.
