---
covers:
  - 'perf(client): switching chats and agents no longer waits on the server (DOR-2891)'
---

### Changed

- Opening a chat you have already seen in the sidebar now shows it straight away, instead of waiting for the server to answer first. DorkOS still checks with the server in the background, and tells you if the chat is gone.
- When you click an agent, its row lights up at once, even while DorkOS is still finding out which chat to open. After your computer wakes from sleep, clicking an agent no longer waits for a fresh list either.
