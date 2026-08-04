---
covers:
  - "feat(db): record a bridged room's platform title at bridge time"
  - 'feat(shared): add RoomBridgeInfo to the room DTO'
  - 'feat(server): wire bridge visibility and platform title onto the room read'
  - 'feat(client): the bridge visibility badge and external-origin marks (DOR-879)'
---

### Added

- A bridged Telegram channel's header now shows whether your agent sees every message there or only the ones that mention it, taken straight from Telegram's own privacy setting for the bot. Tap it to see why, and how to change it on Telegram's side. (DOR-879)
- Anyone bridged in from Telegram is marked with the platform they're on, next to their name in the room's member list and beside every message they send, so you can always tell a person on your own machine apart from someone joining in from outside it. (DOR-879)
