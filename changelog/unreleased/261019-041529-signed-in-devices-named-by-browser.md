---
covers:
  - 'fix: signed-in devices are named by browser, and a sign-in nobody used is not listed (DOR-3099, DOR-3097)'
---

### Changed

- Each signed-in device is now named by its browser, like "Chrome on Mac" or "Safari on iPhone". The device you're using is marked "This device" and is signed out with the Sign out button at the top, not from the list. (DOR-3099)

### Fixed

- Turning on a password with `dorkos auth enable` no longer leaves behind a sign-in no device uses, and one left over from an earlier setup no longer shows up as an extra device. (DOR-3097)
