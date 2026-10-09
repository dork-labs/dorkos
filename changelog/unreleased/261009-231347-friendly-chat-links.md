---
covers:
  - 'feat(chats): friendly chat links, by title, that open in place (DOR-2824)'
---

### Changed

- When an agent links to a chat, the link shows the chat's title, and one click opens it right where you are. Cmd-click or Ctrl-click opens it in a new tab. Links to other websites still ask before they open, and so does any link that would send a message for you (DOR-2824)
- Agents now name chats by their title and link them, instead of showing a string of letters and numbers like `48f74bb4` (DOR-2824)
- A chat an agent starts gets a short, plain title in the sidebar, like "Rooms: always answer people", instead of the first line of the agent's instructions (DOR-2824)
