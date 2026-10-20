---
covers:
  - "fix(server): an agent's level bounds every turn it starts, existing chats included (DOR-3175)"
  - 'fix(server): a chat that follows its agent rises to its level at the next turn (DOR-3175)'
---

### Fixed

- Changing an agent's level now reaches the chats and rooms it already has, from their next message. Before, only new chats followed it: a room the agent already worked in kept its old level, so lowering the agent left its edits going through with no approval card, and raising it left the room asking. This includes chats working in a folder inside the agent's folder.
- A chat keeps its own level when you set one on it, and chats that outside messages reached stay where they were when the agent's level goes up. Lowering reaches every chat. Settings › Runtimes now says so: "Applies to all chats from their next turn. Chats you set by hand only follow it down."
- The history line for a level change says how many existing chats it reached, like "14 chats follow it", and names the chats that rose, so you can find any of them and set it back.

### Changed

- Chats you set to a level by hand before this update now follow their agent. Set them again to keep them where they are.
