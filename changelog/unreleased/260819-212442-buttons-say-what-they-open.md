---
covers:
  - 'fix(client): "Open session" and "Open conversation" say what the button does, instead of promising a message (DOR-1367)'
---

### Changed

- Three buttons now say what they actually do. On the Team page, an agent's row action shows an arrow that points where it takes you, and a screen reader hears "Open session with Ana" instead of "Chat with Ana". On a profile, the button reads "Open session" instead of "Message". In the command palette (⌘K), a direct message reads "Open conversation with Ana" instead of "Message Ana", and pressing it opens the conversation you already have. All three already opened what they open; only the words were wrong (DOR-1367)
