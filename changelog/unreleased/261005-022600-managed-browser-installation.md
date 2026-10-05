---
covers:
  - 'feat(browser): install and verify managed Chromium files'
---

### Added

- Download and verify the experimental managed browser on Apple Silicon Macs with `dorkos browser install`. Check its saved files with `dorkos browser status --runtime`, or replace damaged files with `dorkos browser install --repair`.

### Fixed

- Keep host usernames and program search paths out of isolated extensions on Windows, and distinguish an ordinary crash from running out of memory.
