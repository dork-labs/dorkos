---
covers:
  - "feat(audit): agents can read the record and each other's work chats; your own chats stay private (DOR-2738)"
---

### Added

- Agents can now review each other's work. They can read the record, and any other agent's work chats: scheduled tasks, messages between agents, and replies in the team channels they are in. DorkOS's agent tools and API keep your own chats from other agents, including your direct messages with an agent and chats from Telegram or Slack. An agent can't list, open or search them, though what it did in them is still in the record. This covers agents that say who they are, as DorkOS's tools do. It doesn't stop a program on your computer from opening the chat files directly (DOR-2738)
- See the whole record in the app: switch Activity to All actions. Each agent's profile has an Activity page with everything it did (DOR-2738)

### Security

- An agent could open any chat's messages, including your own chats, through the app's API. It now gets "not found" for your chats on every chat request, and your chats no longer show up in its live list (DOR-2738)
