---
covers:
  - 'fix(claude-code): stop reporting a gated tool call as complete before it is approved'
  - 'fix(opencode): only offer models the sidecar will actually run'
---

### Fixed

- A tool waiting for your approval no longer looks like it already ran. While Claude Code asked "can I write this file?", the file showed as written — the whole time you were deciding. Now it stays marked as in progress until it really finishes, and a tool you turn down is marked as refused instead of done.
- The OpenCode model list no longer offers models OpenCode cannot run. A model you pulled with Ollama used to show up in the menu even when OpenCode knew nothing about it, so picking it was accepted and then the next message failed with "That model isn't available" — pointing you back at the menu that offered it. The menu now shows only models that will actually work.
