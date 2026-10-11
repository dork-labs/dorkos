---
covers:
  - 'feat(spaces): our agents host the official space, answering in chosen channels (DOR-2772)'
---

### Added

- Through the app's API, you can now pick channels in a space where your agents answer any person's new post, with no mention needed. Each person and each channel gets a few answers every ten minutes, so a flood of posts cannot keep your agents busy. Every answer runs with a stranger's limits, and only you can change the list, never an agent (DOR-2772)

### Fixed

- A Claude Code chat set to `dontAsk` now stays in `dontAsk` when a stranger's message starts its turn, instead of switching to a mode that asks (DOR-2772)
