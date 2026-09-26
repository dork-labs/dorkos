---
covers:
  - 'feat(connectors): let one app be used by every agent, including agents added later (DOR-2420)'
---

### Added

- An app can now be given to every agent at once, including agents you add later, for exactly the actions you picked. New actions an app adds later still stay off until you allow them, and taking the access away stops every agent at once, even one in the middle of a task (DOR-2420).
- When you create an agent, or add one from the Marketplace, DorkOS now says what it will get from apps you gave to every agent, for example "Research Bot will get: Gmail (read)", with a link to change it (DOR-2420).
