---
covers:
  - 'fix(client): the little runner on the task bar shows how its task ended (DOR-1119)'
---

### Fixed

- The little running figure on the background task bar now shows how its task ended.
  It used to burst into confetti and then just keep running, so the tick for a task
  that finished, the cross for one that failed, and the dash for one DorkOS lost
  sight of never appeared — the figure ran until the task faded from the bar. The
  figure now settles into its mark after the burst, and a task that is already
  finished when it shows up on the bar opens on its mark instead of pretending to
  run (DOR-1119)
