---
covers:
  - 'fix(client): every surface that says "working" reads the same rule'
---

### Fixed

- The "working right now" strip, the badge on an agent's row, and a folded
  section's count now all agree with the sidebar about what counts as working: a
  conversation you started. A scheduled run no longer lights an agent's badge
  "Working" while the sidebar says nothing — and folding a section no longer
  hides that someone inside it is mid-turn. A stuck or asking automated run still
  comes to you like anything else.
