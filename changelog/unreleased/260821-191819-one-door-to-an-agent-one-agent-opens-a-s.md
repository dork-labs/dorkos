---
covers:
  - 'feat(client,server): one door to an agent — one agent opens a session, two or more start a group message (DOR-1370, DOR-772)'
---

### Changed

- One way in to each agent. Clicking an agent in the sidebar opens your chat with it, and that is now the only place that chat lives. The sidebar used to list the same agent twice, once under Agents and once under Direct messages, and the two opened different things. Pick one agent in the "+ New" picker and you land in that same chat. Pick two or more and you start a group message (DOR-1370).
- Your old one-on-one messages are all still there. Nothing was deleted or moved. Whenever one of them has something new for you it shows up under Today — including a line an agent started by itself — and the agent's own row gets a dot beside it. You can find any of them any time with ⌘K or from the agent's profile. Chats connected from Telegram or Slack keep their own row, since there is a real person on the other end (DOR-1370).
- A group message keeps up with who is in it. Add an agent to a group and its name grows to include them, unless you named the conversation yourself, in which case your name stays (DOR-772).
