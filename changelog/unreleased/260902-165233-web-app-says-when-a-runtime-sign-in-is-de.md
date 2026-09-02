---
covers:
  - 'feat(client): the web app says when a runtime sign-in is dead (DOR-1680)'
---

### Added

- When a runtime's sign-in stops working, the app now shows a banner across the top naming the runtime, with a button that takes you straight to signing in again. Before this, a browser tab told you nothing — a dead sign-in reached you only through the bell, a phone notification, or the desktop app, while your scheduled tasks and agent replies quietly failed. The banner goes away on its own the moment a sign-in works again (DOR-1680)
