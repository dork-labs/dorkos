---
covers:
  - 'fix(sessions): report one permission mode on every session surface (DOR-463)'
---

### Fixed

- The session list now shows the right permission mode for every session. If you switched a session to "Bypass All", the sidebar could still show it as "Default" and leave off the warning icon, even though the session's own toolbar showed the real mode — and a live update could quietly put the wrong value back a moment later. Every place a session appears now reads the same value, so the list matches what the agent will actually do.

### Changed

- When a conversation has to be restarted under a new id — which can happen when an older chat is reopened and cannot be picked up where it left off — the list now shows only the one you would actually land in. Before, the old entry stayed in the sidebar and quietly opened the newer conversation instead, showing the older one's permission mode. If a chat you remember seems to have vanished, look for the newer entry with the same conversation in it; nothing is deleted.
