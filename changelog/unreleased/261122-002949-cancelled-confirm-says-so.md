---
covers:
  - 'fix(client): closing "Confirm it’s you" without confirming now says nothing changed (DOR-4909)'
---

### Fixed

- If you close "Confirm it’s you" without confirming, the app now says that nothing changed. Before, a mini app's card stayed as it was, so it looked like Allow had worked and "Not now" looked like the next step. Other screens showed "Confirm it’s you to do this." after the window had already closed. In the Mac app, the sheet now names the password window and says closing it changes nothing (DOR-4909)
