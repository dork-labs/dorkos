---
covers:
  - 'feat(client): a banner for autonomy nobody is watching (DOR-814)'
---

### Added

- **DorkOS now tells you when something is running without asking and nobody is there to answer.** If a chat integration or a scheduled task is set to **Full autonomy**, a quiet amber line sits under the header on every page: _The Deploys integration and the Nightly cleanup task run without asking. Nobody is watching, so nothing waits for your approval._ It names them rather than counting them, and puts a button beside the words that takes you to the integration or the task so you can change it in a couple of clicks.

  This is the one place that fact had no home. A chat you are sitting in front of shows its trust level in the status strip, right where you are looking. A schedule that fires at 3am and an integration that answers a message from your phone show it only on the screen that configures them — the screen you are not on. The banner appears the moment you turn one on, stays while it is true, and disappears on its own when you dial the last one back. There is nothing to dismiss and nothing new to configure.
