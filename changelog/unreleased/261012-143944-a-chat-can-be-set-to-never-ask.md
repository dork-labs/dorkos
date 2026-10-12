---
covers:
  - 'feat(sessions): a chat can be set to never ask, refusing instead (DOR-2838)'
  - 'fix(sessions): a chat set to never ask still asks nobody under a stricter ceiling'
---

### Added

- A Claude Code chat can now be set to **Never ask**. Turn it on under **Ask first** on the chat's trust dial. The agent runs only what you have already allowed, and refuses everything else instead of stopping to ask you. It never gets to do more than **Ask first** lets it. Only you can turn it on: no DorkOS tool lets an agent switch a chat to it, and a chat set to it cannot start another chat that would ask you. Codex and OpenCode chats don't offer it
