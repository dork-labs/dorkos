---
covers:
  - "fix(extensions): a mini app's server edit runs without a card only when DorkOS can tie it to its author (DOR-4528)"
  - "fix(extensions): every changed file of a mini app is traced by content, and judged again before it runs (DOR-4528)"
---

### Changed

- When an agent edits a mini app it built, the new server code now starts by itself only if DorkOS saw that agent's own chat make the change with its file tools. Any other change, such as one made from a command line or while DorkOS was closed, waits for you to approve it.
