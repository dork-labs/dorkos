---
covers:
  - 'fix(client): a dead boot shows what went wrong instead of a black window (DOR-1451)'
---

### Fixed

- If DorkOS can't finish starting, you now see what went wrong instead of a black window. The page says it couldn't start, gives you a **Try again** button, and keeps the technical error under **Technical details** with a **Copy details** button — so you can send us the exact error rather than a screenshot of nothing. This works everywhere DorkOS opens: the desktop app, the cockpit you start from the command line, and a plain browser tab.
