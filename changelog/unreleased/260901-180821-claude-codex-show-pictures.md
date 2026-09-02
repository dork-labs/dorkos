---
covers:
  - 'feat(server,test-utils): claude-code and codex keep the images their tools return (DOR-1664)'
---

### Added

- See the pictures Claude Code and Codex tools hand back (DOR-1664). Ask Claude Code to read a PNG and the picture now appears in the conversation, right under the step that read it. It is still there when you reopen the chat days later.
- Codex now shows images that come back from a tool, like a screenshot from a connected app.

### Fixed

- Stop dropping images on the runtime most people use. Reading an image file with Claude Code used to produce nothing at all: no picture, no error, no hint that anything had happened. The same silence swallowed images that came back to Codex from a tool.
- Say so when a picture cannot be kept. If it is too big, or a kind DorkOS does not store, the conversation now tells you instead of showing you nothing.

### Note for people upgrading

- Codex cannot show an image its own model drew. The Codex software DorkOS talks to has no way to send one, so there is nothing for DorkOS to pick up. Images from tools are the only kind Codex has today, and those work now.
