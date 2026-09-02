---
covers:
  - 'feat(client): the web app says when a runtime sign-in is dead (DOR-1680)'
  - 'fix(server,client): a restart can no longer strand the sign-in banner (DOR-1680)'
---

### Added

- When a runtime's sign-in stops working, the app now shows a banner across the top naming the runtime, with a button that takes you straight to signing in again. Before this, a browser tab told you nothing — a dead sign-in reached you only through the bell, a phone notification, or the desktop app, while your scheduled tasks and agent replies quietly failed. The banner clears itself on the next task, message or reply that gets through on that runtime, since trying is the only way DorkOS can tell that a sign-in works again (DOR-1680)

### Fixed

- Restarting DorkOS while a sign-in was broken no longer leaves a warning behind that nothing can clear. DorkOS forgets which sign-ins were broken when it restarts, so it now closes those older warnings on the way back up and says a restart is what closed them — if a sign-in is still broken, the next task or reply raises it again (DOR-1680)
