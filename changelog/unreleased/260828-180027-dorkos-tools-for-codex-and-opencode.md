---
covers:
  - 'feat(config): runtimes.dorkosTools experiment leaf (DOR-1613)'
  - 'feat(runtimes): give codex and opencode the DorkOS tools over /mcp (DOR-1613)'
  # The two below are folded in deliberately, with no bullet of their own.
  #
  # The first corrects a defect in the feature above, on the same branch,
  # before either ever shipped: a "Fixed" line would describe to people a
  # problem they never had. The second only moves code between files and
  # deletes an unused function — there is nothing in it a person could notice.
  - 'fix(runtimes): keep codex MCP credentials out of the spawned argv (DOR-1613)'
  - 'refactor(server): extract codex header-env + opencode prompt assembly; drop dead gate (DOR-1613)'
---

### Added

- Your Codex and OpenCode agents can now use the same DorkOS tools your Claude Code agents already have — posting in rooms, reacting with an emoji, reading back what was said, and remembering things between sessions. It is off to start with: turn on **DorkOS tools in every runtime** in Settings under Experiments, and it takes effect on those agents' next turn. Expect their turns to cost a little more, since they now carry a longer list of tools (DOR-1613)

### Fixed

- Fixed the address DorkOS gives Codex for the panel it uses to open things on your screen. It was fixed to one form of "this machine", which is not always the one DorkOS is listening on — so on some Macs, and inside Docker on Windows, Codex could not reach it at all (DOR-723)
