---
covers:
  - 'fix(client): the window tab strip fades the edge that hides tabs and keeps the active tab in view (DOR-3507)'
---

### Fixed

- When you have more tabs than fit across the top of the window, the strip now fades out at the edge where more tabs are hidden, so you can tell there are more. The tab you are on also scrolls into view on its own, clear of that fade, when you switch with a shortcut, close the tab next to it, or make the window narrower. (DOR-3507)
