---
covers:
  - 'fix(server): "Confirm it’s you" counts only from a page loaded after a mini app was paused (DOR-5026)'
  - 'fix(client): the stale-page refusal says to try again after signing in (DOR-5026)'
---

### Fixed

- Hardened "Confirm it’s you". After a mini app is paused or turned off, a confirm now counts only from a page DorkOS loaded after that, in the browser and in the Mac app. "Sign in again" now reloads the page for you. Afterwards, click the button you were confirming again. A page left open while you update DorkOS needs one reload before a confirm counts (DOR-5026)
