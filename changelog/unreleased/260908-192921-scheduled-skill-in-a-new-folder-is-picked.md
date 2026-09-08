---
covers:
  - 'fix(server): a scheduled skill in a new folder is picked up in seconds (DOR-1908)'
---

### Fixed

- A scheduled skill you add to a new folder is picked up within seconds instead of up to five minutes. If the folder DorkOS reads schedules from did not exist yet — a fresh project, or an agent you just added — the first schedule you put there could sit unnoticed for the whole time DorkOS was running, and only a restart would find it. Now DorkOS starts reading the folder the moment it appears. The same fix covers the two other ways the folder-watching could go quiet: a busy machine running several agents at once can use up the operating system's supply of folder watches, and a schedule saved in the first fraction of a second after DorkOS starts watching could slip past. In all three cases DorkOS now checks the folder itself every ten seconds until the watching is working again, so a schedule you add still starts on time. If everything is working normally, nothing changes and nothing costs you anything extra (DOR-1908)
