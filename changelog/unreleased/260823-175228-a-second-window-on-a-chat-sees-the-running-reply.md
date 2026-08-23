---
covers:
  - 'fix(server): a second window on a chat sees the reply already in progress (DOR-1444)'
  - 'fix(server,client): a chat link without the folder reads the right project (DOR-1444)'
---

### Fixed

- Open the same chat in a second window and you now see the reply that is already being written, plus the Stop button, right away. Before, that window could sit blank and say "Live updates lost".
- A chat link that leaves out the folder now shows the conversation and stays live. DorkOS looks up the folder the chat is running in instead of falling back to a default one. The name in the title bar can still be wrong on those links — that part is not fixed yet.

### Security

- Leaving the folder out of a request no longer reads a chat that naming the same folder would be refused for. Every session request is now checked against your allowed folders, whether you named one or DorkOS worked it out.
