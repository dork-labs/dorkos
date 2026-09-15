---
covers:
  - 'feat(server,mesh): an agent registering an agent can give it a name, an emoji and a colour (DOR-2054)'
  - 'fix(server,mesh): one identity gate for every path that registers an agent (DOR-2054)'
  - 'fix(server,mesh): only a name with a space in it is read as a label (DOR-2054)'
---

### Added

- An agent that registers another agent can now give it a name to show, an emoji and a colour,
  instead of leaving it with a face DorkOS picked. If it sends something that is not one emoji,
  or a colour that is not a hex code like `#ec4899`, DorkOS turns the call down and says what it
  wanted rather than storing it (DOR-2054)

### Fixed

- Stop turning a friendly name into a broken one. An agent's short name is permanent and is what
  its `@handle` in a room is made from, so "DorkOS Cloud" used to be stored with the spaces still
  in it. DorkOS now shortens it to `dorkos-cloud` and keeps "DorkOS Cloud" as the name you see in
  the app (DOR-2054)
- Keep the name you typed when creating an agent from the app or the API. It was accepted and
  then thrown away, so the agent ended up showing its short name to everybody (DOR-2054)
