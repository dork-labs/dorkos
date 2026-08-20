---
covers:
  - 'fix(client): StrictMode mount-guard bug, timer truncation, nested ternaries (DOR-1379)'
---

### Fixed

- Copying two things back to back no longer cuts the first one's checkmark short. Also fixed a rare case in dev builds where making a channel with a name that's already taken could show both an inline message and a separate pop-up saying the same thing.
