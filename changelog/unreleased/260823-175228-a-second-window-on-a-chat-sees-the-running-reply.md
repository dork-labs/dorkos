---
covers:
  - 'fix(server): a second window on a chat sees the reply already in progress (DOR-1444)'
---

### Fixed

- Open the same chat in a second window and you now see the reply that is already being written, plus the Stop button, right away. Before, that window could sit blank and say "Live updates lost".
- A chat link that leaves out the folder now works. DorkOS looks up the folder the chat is running in instead of guessing, so the conversation loads and stays live.
