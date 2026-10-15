---
covers:
  - 'feat(connectors): say when a sign-in setup needs a fix, not "try again later"'
---

### Changed

- When an app can't be connected because its sign-in setup in DorkOS has a problem, the connect dialog now says so and drops the retry button. Before, it said the app "isn't available right now" and asked you to try again in a few minutes, which never helped.
