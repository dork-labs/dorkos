---
covers:
  - 'fix(server): a chat that reads outside words through a tool asks before risky actions (DOR-3291)'
---

### Fixed

- When an agent reads something written outside your team, like an email, a web page, a stranger's message in a room, or a package's description, its chat now remembers that. From then on, in that chat, risky actions ask you first: sending from a connected app, deleting something that can't be undone, running shell commands, and editing the agent's own setup or its mini apps. This lasts for the rest of the chat, because the words stay in the agent's memory of it. Chats set to Full autonomy still never ask. Ordinary work and reading your own files don't change anything.
