---
covers:
  - "refactor(client): the hub's reusable guts move to the entities that own them (DOR-1253)"
  - 'feat(client): profile pages and pickers for the agents you manage (DOR-1253)'
  - 'fix(client,server): a profile edit changes what it names, and nothing else (DOR-1253)'
  - 'feat(client): the profile playground draws its pushed pages against a real manifest (DOR-1253)'
---

### Added

- An agent's profile now opens onto everything it does. Tap a row to see its conversations (with a search box), its scheduled tasks, the rooms it is in, its skills, its tools and MCP servers, its connections, and the two files that shape how it behaves — its instructions and its boundaries (DOR-1253)
- Each row tells you how much is behind it before you open it: how many conversations and when the last one moved, how many tasks and when the next one runs, how many skills and servers (DOR-1253)
- Change what an agent runs on — its runtime, its model and how hard it thinks — straight from its profile, and change its personality the same way (DOR-1253)
- Tap an agent's face to open an Appearance page where you pick its colour, its emoji and its personality in one place (DOR-1253)
- The ⋮ menu on an agent's profile is where you make it the default, block it, unregister it, or delete it and its data. Deleting asks you to type the agent's name first (DOR-1253)

### Fixed

- Writing an agent's instructions (SOUL.md) or boundaries (NOPE.md) now actually saves them. The old Agent Hub let you type in both editors and quietly threw the text away (DOR-1253)
- Changing one thing about an agent no longer erases another. Setting its model used to wipe its description and everything in its capabilities list (DOR-1253)
- Renaming an agent updates its name everywhere at once — the profile, the team page and the sidebar (DOR-1253)
