---
covers:
  - 'feat(chat): a link to a chat, channel or DM shows as a chip (DOR-2824)'
  - 'fix(chat): a chip keeps focus as its status changes, and names a bad id not found (DOR-2824)'
---

### Added

- A link to a chat in an agent's reply or a channel post now shows as a small chip: the agent's icon, the chat's title, and a dot for what the chat is doing. Rest the pointer on it to read what that is, like "Waiting for your OK". One click opens the chat; cmd/ctrl-click opens it in a new tab (DOR-2824)
- Links to channels and direct messages show as chips too, named the way their tabs are (DOR-2824)
- A link to a chat or channel that is gone says "Chat not found" or "Channel not found" instead of an empty link (DOR-2824)
