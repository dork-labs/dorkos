---
covers:
  - 'feat(client): read what your agent will actually be given, before you save it'
  - "fix(client): DorkBot's personality is yours to change, as onboarding promised"
  - 'fix(client): an agent the roster cannot name still has a door to its profile'
---

### Added

- **See exactly what your agent reads.** The Instructions and Boundaries pages of an agent's profile now end with a line you can open: **Preview what your agent will see**. Inside is the real thing — the agent's name and description, its personality written out in full, your instructions and your boundaries, assembled the way the agent gets them. It follows what you have typed, so you can read it before you save (DOR-1255)

### Fixed

- **DorkBot's voice is yours to change.** Setup asks you to pick how DorkBot should sound, but its profile then refused to let you change your mind. Now the **Personality** row on DorkBot's profile opens the same picker every other agent has. Its name, its face and its description still belong to DorkOS (DOR-1255)
- An agent your fleet can no longer name — one you retired while the app was open — still opens from the sidebar instead of going quiet (DOR-1255)
