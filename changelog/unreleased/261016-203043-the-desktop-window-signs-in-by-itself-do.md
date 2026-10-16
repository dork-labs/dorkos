---
covers:
  - 'feat: the desktop window signs in by itself (DOR-2966)'
  - "fix(desktop): the window's sign-in request keeps its cookie (DOR-2966)"
---

### Changed

- The Mac app signs you in by itself. If you turned on "Ask for a password on this computer too", the app's own window no longer asks; browsers on this computer and your other devices still do. The sign-in lasts until you quit the app and is never saved to disk (DOR-2966)
