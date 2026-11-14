---
covers:
  - 'fix(server): a busy machine gets the plain settings message at start-up, not a stack trace (DOR-4354)'
---

### Fixed

- On a very busy computer, DorkOS could stop while starting and print a wall of error text, even though your settings had loaded fine. It now shows the same short message it gives for any settings file it can't read right now: what went wrong, that your settings were not changed, and to start DorkOS again. (DOR-4354)
