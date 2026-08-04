---
covers:
  - 'fix(client): mesh topology graph drops the last "Integration" and shows plain chat-type labels (DOR-896)'
---

### Changed

- The agent map (Discovery → topology graph) no longer says "Integration" anywhere: the edge label, the "Remove" button, the drag-to-connect hint, and the remove-connection dialog all say "Connection" now, matching the rest of the app.
- A binding's chat-type badge on the graph now reads in plain language ("Direct message", "Group", "Broadcast channel", "Thread") instead of the raw platform value.
