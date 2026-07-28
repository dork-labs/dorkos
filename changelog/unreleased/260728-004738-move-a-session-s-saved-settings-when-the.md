---
covers:
  - "fix(sessions): move a session's saved settings when the runtime re-keys it (DOR-493)"
---

### Fixed

- Your permission choice now sticks to a chat for good. Claude Code gives a new chat its real ID partway through the first reply, and settings you picked before that were left behind under the old ID. If the chat then sat idle for a while, or you restarted DorkOS, the next message quietly ran at the default setting instead of the one you chose — so an agent you had set to act on its own might start asking again, or the reverse. The setting now moves with the chat, and every screen reads it from the same place.
