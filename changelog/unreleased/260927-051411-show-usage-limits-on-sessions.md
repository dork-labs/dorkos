---
covers:
  - 'feat(server): show a hard usage limit on the session and notify once per limit (DOR-2382)'
---

### Fixed

- When a Claude account runs out of usage, the session no longer stops without a word. It now shows Claude's own message, such as "You've hit your weekly limit", and it remembers that the account is out until the limit resets, even after DorkOS restarts. The limit clears when you send the session its next message (DOR-2382)

### Added

- You get one notification when a Claude account runs out of usage, saying when it comes back, however many sessions were using that account (DOR-2382)
