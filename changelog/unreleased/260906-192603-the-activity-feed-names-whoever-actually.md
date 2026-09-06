---
covers:
  - 'fix(server): the activity feed names whoever actually did it (DOR-1829)'
---

### Fixed

- Activity now says which agent registered or removed an agent, added a chat connection, changed a chat route, or created, paused, deleted or cancelled a scheduled task. Those entries always said "You" before, so work one of your agents did looked like something you did yourself. What you do in the app still says "You", and a caller DorkOS cannot identify is shown as an unidentified caller rather than as you (DOR-1829)
- Activity now records removing an extension's secret and putting one of its settings back to the default. Setting them was already recorded; taking them away was not (DOR-1829)
