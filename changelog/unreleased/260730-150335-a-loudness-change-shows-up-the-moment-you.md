---
covers:
  - 'feat(rooms): a loudness change shows up the moment you make it'
---

### Changed

- Changing how loud an agent is in a room now moves the meter straight away instead of waiting for the server. While it is being saved the pill dims, and if the save is refused the setting goes back to what it really is and the row says why — so the control never shows a value that was never stored.
