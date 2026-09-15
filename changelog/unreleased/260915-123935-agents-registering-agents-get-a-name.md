---
covers:
  - 'feat(server,mesh): mesh_register takes a display name, an emoji and a colour (DOR-2054)'
  - 'fix(mesh): a display name sent at registration reaches the manifest (DOR-2054)'
---

### Added

- An agent that registers another agent can now give it a name to show, an emoji and a colour,
  instead of leaving it with a random face. If it sends something that is not one emoji, or a
  colour that is not a hex code like `#ec4899`, DorkOS turns the call down and says what it
  wanted rather than storing it (DOR-2054)

### Fixed

- Stop turning a friendly name into a broken one. An agent's short name is permanent and is how
  other agents address it, so "DorkOS Cloud" used to be stored with the spaces still in it.
  DorkOS now shortens it to `dorkos-cloud` and keeps "DorkOS Cloud" as the name you see in the
  app (DOR-2054)
