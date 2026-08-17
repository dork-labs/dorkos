---
covers:
  - 'feat(server,client): an Experiments section in Settings — staged opt-ins get a real switch (DOR-1304)'
---

### Added

- Settings has a new **Experiments** section: things that work but that we have not lived with long enough to make the default. Each one says what it gives you and what it costs, and they are all off until you turn them on. Two are waiting there now. **Keep agents warm between messages** leaves your agent running between messages, so replies from the second message on start about 4× faster — it holds up to about 1 GB of memory per warm agent, and applies to chats you start after turning it on. **Let outside agents reach yours** opens the A2A gateway, which lets agents built by other people send work to yours; it is still early alpha, and turning it on opens a door, so only do it when you know what is on the other side. Every experiment ends the same two ways — it becomes the normal behaviour, or it goes away — so an empty list means nothing is waiting on you (DOR-1304).

### Changed

- The A2A gateway can now be turned on from Settings instead of only from an environment variable. If your machine sets `DORKOS_A2A_ENABLED`, that still wins either way, and the switch shows you what is really running rather than offering a choice the server would ignore (DOR-1304).
