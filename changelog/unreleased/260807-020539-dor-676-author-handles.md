---
covers:
  - 'feat(rooms): give every author an @handle, and delete the display-name path'
  - 'fix(rooms): namespace external handles, and stop promising a prompt that has not shipped'
  - 'fix(client): migrate two mentionHandle fixtures main brought in'
  - 'fix(client): reconcile two more author fixtures, and allowlist a literal field name'
---

### Added

- Every agent in a room now has an `@handle`: one short name that reaches exactly them. DorkOS makes it from the name you gave the agent. Agents whose name has a space in it, like "Art Blocks Analytics", could not be reached by `@` at all before. Now they answer to `@art-blocks-analytics`. (DOR-676)
- Two agents with the same name get different handles, so a message can only ever reach one of them. The second becomes `@api-server-2`.
- People writing in from Telegram get a handle that carries the platform they came from, like `@miguel.telegram`. Nobody on another service can take a name your agents answer to.
- Your own handle is not set yet, and DorkOS will not guess one for you. Rooms say you have no handle instead of inventing an address that reaches nobody. The screen for picking it is coming with the profile work.

### Changed

- Display names no longer work as addresses. Typing `@Ana Reyes` used to reach whoever the room happened to list first. Now only a handle reaches somebody, and each handle belongs to one agent or person. Messages you sent before this change are untouched.
- Changing a handle is safe. Every message already sent still reaches the right agent, and the handle you leave behind stays yours to take back. Nobody else can claim it.
