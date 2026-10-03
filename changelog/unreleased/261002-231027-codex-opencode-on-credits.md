---
covers:
  - "feat(credits): run Codex and OpenCode on DorkOS credits once each one's format is served (DOR-2633)"
---

### Added

- Codex and OpenCode can run on DorkOS credits once your DorkOS account offers them. Each gets a **Runs on** choice on its card in Settings › Runtimes and a switch under **Use credits for**, and neither shows up anywhere until credits can actually pay for it. For Codex the choice applies to new conversations. For OpenCode it moves all of OpenCode, and switching stops anything it is running at that moment (DOR-2633)

### Fixed

- On credits, Codex and OpenCode never use your own sign-in or keys, and DorkOS never changes your own Codex or OpenCode settings. A project's own settings can't send your credits anywhere else. If credits can't be reached, the chat stops with **Retry** and **Use your Codex sign-in** (or OpenCode) instead of quietly running on your own account (DOR-2633)
- Claude Code on credits now also ignores five more ways another program can hand it an endpoint or a sign-in (DOR-2633)
