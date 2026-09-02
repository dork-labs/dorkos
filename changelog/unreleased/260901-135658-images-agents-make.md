---
covers:
  - 'feat(shared,server,client): a message can carry an image, by reference (DOR-1663)'
---

### Added

- See the pictures your agents make (DOR-1663). When an agent generates an image, or a tool hands one back (a screenshot, an image from an MCP server), it now appears in the conversation where it happened and is still there when you come back to it later.

### Fixed

- Stop losing images without saying anything. An image your agent produced used to be thrown away in silence: the turn finished, you were charged for it, and nothing appeared. If an image can't be kept now — it's too big, or it's a kind we don't store — the conversation says so instead of showing you nothing.
- Stop losing whole turns. If the only thing an agent produced was an image, the entire turn used to vanish from the conversation, not just the picture.

### Note for people upgrading

- Images that come back from a tool now work on all three: Claude Code, Codex and OpenCode. Images an OpenCode model draws itself are still dropped by OpenCode before DorkOS ever sees them ([anomalyco/opencode#46600](https://github.com/anomalyco/opencode/issues/46600)); DorkOS is ready for them the day that's fixed.
