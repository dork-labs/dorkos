---
covers:
  - 'feat(runs): spin-offs and new chats from the web wait for a free slot instead of being refused (DOR-5214)'
---

### Changed

- When the computer is running as many agent chats as it allows, a chat an agent starts no longer fails with "Too many spin-off chats are running". It is started, waits its turn, and runs when a slot frees. The agent is told it is waiting, and where it is in line. (DOR-5214)
- Starting a fifth new chat from DorkOS on the web while four are still working no longer fails with "Too many new chats are running". The chat opens, and its first message goes to the agent once one of the others finishes. (DOR-5214)
