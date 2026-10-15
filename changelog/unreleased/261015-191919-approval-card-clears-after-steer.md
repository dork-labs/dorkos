---
covers:
  - 'fix(client): clear an approval answered after a message steered in'
---

### Fixed

- When a message arrived in a chat while an approval was waiting, the "waiting on you" card could stay up after you answered. Its buttons did nothing and the message box stayed hidden until the agent finished. The card now clears as soon as you answer.
