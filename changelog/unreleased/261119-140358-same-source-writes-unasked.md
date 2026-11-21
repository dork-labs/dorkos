---
covers:
  - 'feat(connectors): an agent that only read an app can write back to it without asking, once you turn that on (DOR-4794)'
---

### Added

- For supported apps (Linear today), when you turn it on, an agent that only read that app can write back to it without asking you. It starts off. Apps whose changes reach other people, like mail, don't offer it. Sends, deletes, and a turn that also read or carried in words from anywhere else still ask first. DorkOS can't see whether an app copies what it holds to another place on its own, so turning it on asks you to confirm it doesn't. Each write that skips the ask leaves a line in Activity.
