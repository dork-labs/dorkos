---
covers:
  - "feat(rooms): room list carries mention counts and each room's last line"
  - 'feat(sidebar): new messages make a room bold, and only mentions and DMs get a count'
  - 'feat(sidebar): a folded section keeps its unread rows, and headers carry no counts'
  - 'fix(rooms): last lines start from the room list, honour the join floor and drop markdown; mention counts stop at ten'
  - "fix(sidebar): threads drop the room's mention count, agent rows show their Direct chat, one tooltip, no doubled rows on fold"
---

### Changed

- A channel with new messages now shows its name in bold, with no number beside it. A number appears only when something is meant for you: a message that @mentions you, or a new message in a direct message. The number is small and grey, and shows 9+ once it passes nine (DOR-3077)
- Mentions are counted from the conversation itself, so reading a room clears its number on every device
- Muting a room takes away its bold, but a message that @mentions you still shows its number
- Folding a sidebar section keeps its unread rooms in view under the section's name, instead of adding a count to the name

### Added

- Rest your pointer on a room in the sidebar to see its name and its last message, as plain text
- A direct message shows a soft dot on the agent's face while it is working

### Fixed

- An agent's row in the sidebar now shows its direct chat's new messages, in bold with a count, on the phone's All tab and in Library on a computer
