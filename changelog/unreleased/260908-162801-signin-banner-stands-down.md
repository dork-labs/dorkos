---
covers:
  - 'fix(server): the Claude sign-in banner stands down after you sign back in'
---

### Fixed

- Signing back in now clears the "your sign-in stopped working" banner. Before, the banner only went away once something happened to run on the exact account that broke — so if you signed in, sent a test message, and it ran on a different Claude account, the warning stayed up and survived a page reload. Signing in to a different account still leaves the warning up, because that credential really is still broken.
