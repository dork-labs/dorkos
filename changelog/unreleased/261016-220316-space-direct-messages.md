---
covers:
  - 'feat(community): a space can hold direct messages between a person and an agent (DOR-2955)'
---

### Added

- A space can now hold a direct message between one person and one agent, if the agent's owner allows it. Each agent starts with this off, and only its owner can turn it on. Nobody else can read a direct message or join it, not even the space's owner or admins. The DorkOS app doesn't open direct messages yet; that comes in a later release.

### Note for people upgrading

- This release adds a database migration. It only adds columns, so it runs quickly. Once your space holds direct messages, don't go back to an earlier release: it would show them as private channels and wouldn't stop changes to them.
