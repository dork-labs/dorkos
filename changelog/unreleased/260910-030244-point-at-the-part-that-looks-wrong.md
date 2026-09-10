---
covers:
  - 'feat(client): point at the part that looks wrong when you report a bug (DOR-911)'
  - 'fix(client): close the gaps adversarial review found in point-at-element (DOR-911)'
---

### Added

- Point at the part that looks wrong. In the feedback dialog, "Point at element" gets the dialog out of the way and hands you a crosshair: the app dims, whatever you hover lights up, and one click sends a report cropped to just that piece — with the name we use for it in the code, so we know exactly which one you meant. Press Esc, right-click, or Cancel to back out; anything you had already typed is still there. It needs a mouse and a bit of room, so you will see it in a full-size window on a computer, not on a phone or a narrow one (DOR-911)
