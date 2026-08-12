---
covers:
  - 'fix(client): the row of tabs on Home shows when it holds more than fits (DOR-1180)'
  - 'fix(client): the right panel reveals its selected tab when the panel alone gets narrower (DOR-1180)'
---

### Fixed

- The row of tabs across the top of Home — Home, Activity, Scheduled, Workspaces — is wider
  than a phone screen, and the last word used to be chopped off mid-letter with nothing to
  say why. It now fades out at whichever edge still has tabs behind it, so it reads as
  something to swipe rather than something broken, and opening a link straight to Workspaces
  scrolls that tab onto the screen instead of leaving it past the edge (DOR-1180)
