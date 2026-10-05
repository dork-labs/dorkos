---
covers:
  - 'feat(extensions): carry agent tools across the isolation boundary (DOR-2686)'
---

### Added

- An extension that runs separately from DorkOS can now give your agents tools, the same way one running inside DorkOS does. Each call still goes through your permissions first, inside DorkOS. If the extension crashes or freezes, its tools disappear until it is running again, and a call that was in progress fails instead of waiting. (DOR-2686)
