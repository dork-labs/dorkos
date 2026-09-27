---
covers:
  - "feat(rooms): run room turns in the agent's own folder with the room's files granted (DOR-2410)"
  - 'fix(rooms): never run a program from a submodule or a borrowed folder in a room turn (DOR-2410)'
---

### Changed

- In a room that has files of its own, an agent now works from its own folder instead of from its copy of the room's files. It keeps its own personality, safety rules and memory in that room, the same as everywhere else, and it reaches the room's files by their full paths (DOR-2410).
- An agent in a room about its own project can now change its own code in the same conversation where it works on the room's files. Its instructions tell it to do that in a private copy of its own project, so it doesn't edit the folder other conversations with it may be using at the same time (DOR-2410).
- Picking up a room conversation in the app puts the agent in its own folder too, with the same access to the room's files it has in the room (DOR-2410).
- Conversations agents had in rooms with files before this update stay in their lists. Claude Code and Codex pick them up where they left off. An OpenCode agent can't move an old conversation to its own folder, so its next turn in that room starts a fresh conversation there, and the old one stays in its list (DOR-2410).

### Security

- An agent can only change the parts of a room's shared history that saving its own work needs. Settings and scripts that run for everyone in the room stay out of its reach, and DorkOS no longer follows a pointer an agent could rewrite when it checks an agent's copy (DOR-2410).
- A task, a chat connection, a message from another agent or a room turn for one agent can no longer run inside another agent's folder or inside a room's files. It stops with a message saying why instead (DOR-2410).

### Note for people upgrading

- If an agent is set to use no folder of its own, its tasks and chat messages run in your default folder. In a DorkOS development checkout that folder is the `dorkos` agent's own folder, so those tasks now stop with a message. Set a default folder that belongs to no agent, or give the agent a folder of its own (DOR-2410).
