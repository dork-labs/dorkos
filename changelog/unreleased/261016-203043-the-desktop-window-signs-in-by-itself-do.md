---
covers:
  - 'feat: the desktop window signs in by itself (DOR-2966)'
  - "fix(desktop): the window's sign-in request keeps its cookie (DOR-2966)"
  - 'fix: desktop sign-in review fixes (DOR-2966)'
---

### Changed

- The Mac app now signs you in by itself, so the things only you can do at your Mac work without a password. If you turned on "Ask for a password on this computer too", the app still asks, as before. The sign-in lasts until you quit the app and is never saved to disk (DOR-2966)
