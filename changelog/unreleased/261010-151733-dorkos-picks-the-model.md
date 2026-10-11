---
covers:
  - 'feat(doe): DorkOS picks the model on credits (DOR-2784)'
  - 'fix(config): seed the DorkOS model preference under 0.109.0 (DOR-2784)'
---

### Changed

- DorkOS now picks the model for you. On DorkOS credits, a new chat on the DorkOS runtime just works, with nothing to set up first. To choose a model yourself, open Settings › Runtimes › DorkOS and use the Model row. Picking a model there never changes what pays for your chats, and "Chosen by DorkOS" hands the choice back (DOR-2784)
- The model is no longer shown in the bar under the message box. Pin it from the `⋯` menu if you want to see it there. A DorkOS chat no longer shows "Runs on" there either, unless you pin it (DOR-2784)
