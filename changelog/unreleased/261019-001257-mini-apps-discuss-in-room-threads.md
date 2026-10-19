---
covers:
  - "fix(extensions): a mini app's reply keeps its outsider mark across a restart and in later turns (DOR-3017)"
  - "fix(extensions): a mini app's reply wakes agents at the default level, and rooms can't be granted from Wi-Fi (DOR-3017)"
  - 'feat(extensions): mini apps read and reply in room threads as you (DOR-3017)'
---

### Added

- Talk about a post or task right inside a mini app. A mini app can show a room thread and let you reply there, under your own name. You choose which rooms it uses in Settings → Extensions, and it only sees what you can see there. Agents and other websites can't reply as you through it, and an agent a mini app's reply wakes runs at the default level and asks first. Each reply is in the audit trail with the mini app named. A mini app runs with your access, so only turn on ones you trust. (DOR-3017)
