---
covers:
  - 'fix(server): at Full, a turn that read outside words asks before a connected-app send or anything that cannot be undone (DOR-3683)'
---

### Security

- In a chat set to **Full**, an agent that has read words from outside your team now asks you before it sends, replies to or forwards an email, creates or changes a calendar event with guests, or takes any action in a connected app that can't be taken back. Before, it did these on its own and only Activity recorded them. Drafts, labels, reading, and chats with no outside words still run without asking (DOR-3683)
