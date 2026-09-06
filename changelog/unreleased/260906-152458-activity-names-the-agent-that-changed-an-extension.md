---
covers:
  - "fix(server): the activity feed says which agent changed an extension's settings (DOR-1801)"
---

### Fixed

- Activity now names the agent that changed an extension's settings or secrets. Those entries always said "You" before, so a change one of your agents made looked like something you did yourself. A change you make in the app still says "You", and a caller DorkOS cannot identify is shown as an unidentified caller rather than as you (DOR-1801)
