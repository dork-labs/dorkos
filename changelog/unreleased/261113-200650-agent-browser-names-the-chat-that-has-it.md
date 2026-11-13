---
covers:
  - 'fix(local-browser): the Agent browser panel names the chat that has it, and moves it here in one click (DOR-4265)'
---

### Fixed

- When another chat has the Agent browser, the browser panel now says which chat and which agent, with a link to that chat, and a **Use it here** button. Using it here takes the browser away from that chat until you move it back. Before, the panel showed no page and no way to take it. (DOR-4265)
- When no chat has the browser yet, the panel leads with **Open browser**. (DOR-4265)
- An agent that can't use the browser now hears why: it isn't open yet, another chat has it (named by that chat's title), or you moved it to another chat. So it can tell you what to do. (DOR-4265)
