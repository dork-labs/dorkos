---
covers:
  - "fix(extensions): don't permanently cache a one-time environment failure as a compile error"
  - 'fix(mesh): downgrade the expected homedir-fallback skip log from warn to debug'
---

### Fixed

- Fix an extension staying broken forever after a brief glitch on your machine — like running
  low on memory or disk space for a moment during startup. DorkOS used to remember that
  one-time hiccup as if the extension itself were broken, and would repeat the same error on
  every restart even after the glitch was long gone. Now it only remembers a real problem with
  the extension's own code; anything else gets a fresh try next time.
- Quiet down a harmless background message that was showing up as a warning dozens of times a
  day. It's a safety check working exactly as intended, not a sign of trouble.
