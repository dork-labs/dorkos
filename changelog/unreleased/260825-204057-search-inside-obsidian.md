---
covers:
  - 'feat(client): the search box appears wherever there is an index behind it (DOR-1563)'
---

### Added

- You can now search what was said from inside Obsidian. ⌘⇧F opens the same box as the DorkOS app, over the same history, showing you the same things — and ⌘K offers the way in, the same as it does in a browser (DOR-1563)
- It appears only where there is something to search. On a machine where DorkOS has never run, or in an Obsidian this build of the plugin has no database engine for, the box and the ⌘K row are simply not there — rather than being there and finding nothing (DOR-1563)
- The box tells you the one way it differs there: in Obsidian it shows what the DorkOS app has already indexed, so anything said while only Obsidian was open turns up once you have opened the app. Your channels and direct messages are current either way (DOR-1563)
