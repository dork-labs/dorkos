---
covers:
  - 'fix(server): a schedule in a new folder is found in seconds (DOR-1908)'
  # Containment for the catch-up scan this same change introduced — never
  # shipped, so it has no user-facing bullet of its own.
  - 'fix(server): one bad schedule file cannot cost a root the rest (DOR-1908)'
---

### Fixed

- A scheduled skill you add to a new folder is picked up within seconds instead of up to five minutes. If the folder DorkOS reads schedules from did not exist yet — a fresh project, or an agent you just added — the first schedule you put there could sit unnoticed for as long as DorkOS kept running, and only a restart would find it. Now DorkOS starts reading the folder the moment it appears (DOR-1908)
- Folder-watching can also go quiet in two other ways: a busy machine running several agents at once can use up the operating system's supply of folder watches, and a schedule saved in the first moment after DorkOS starts watching can slip past. In both cases DorkOS now checks the folder itself every ten seconds for as long as it needs to, so the schedule still starts on time. When everything is working normally, nothing changes (DOR-1908)
