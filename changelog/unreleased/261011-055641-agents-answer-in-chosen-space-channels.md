---
covers:
  - 'feat(spaces): our agents host the official space, answering in chosen channels (DOR-2772)'
  - "fix(spaces): hold strangers' turns to reads inside the folder, and charge each answer-in post once (DOR-2772)"
---

### Added

- Through the app's API, you can now pick channels in a space where your agents answer any person's new post, with no mention needed. Each person and each channel gets a few answers every ten minutes, so a flood of posts cannot keep your agents busy. Every answer runs with a stranger's limits, and only you can change the list, never an agent (DOR-2772)

### Security

- When a stranger's message in a space or a connected chat starts an agent's turn, the agent now asks you before it reads a file outside its own folder or opens a web page. Before, those reads ran without asking (DOR-2772)

### Fixed

- A Claude Code chat started in the `claude` command line in `dontAsk` mode stays in `dontAsk` when a stranger's message starts its turn, instead of switching to a mode that asks (DOR-2772)
