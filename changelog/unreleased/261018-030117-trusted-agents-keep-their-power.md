---
covers:
  - 'fix(server): on Trusted, our agents keep their power when they talk to each other'
---

### Fixed

- On the Trusted setting, your agents no longer lose power when they talk to each other. Before, when one agent mentioned another in a channel, or sent it a message, the second agent could drop to asking for approval, even if you had set it to never ask. Now it works at the level you set. Messages from people outside your team, and from connected chats like Telegram and Slack, still hold an agent back exactly as before.
- On the Trusted setting, a chat an agent starts now gets the same permission level as the agent's own chat, including Bypass permissions, when starting it needs no approval.
