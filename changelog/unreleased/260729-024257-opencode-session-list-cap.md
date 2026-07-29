---
covers:
  - "fix(opencode): list every session past the sidecar's silent 100 cap"
---

### Fixed

- OpenCode sessions no longer go missing once a project has more than 100 of them. Older ones used to drop off the list quietly — nothing failed and nothing said anything was hidden, so the list just looked short. The background sessions your agent starts for its own subtasks counted toward that 100 as well, so you could lose sight of your own sessions even sooner. Opening one of the hidden ones could also fail with a message saying the session did not exist, when it did. They are all listed and openable again, and if a project ever holds more sessions than OpenCode can hand over at once, DorkOS reports a problem loading the list instead of quietly showing you a shorter one. (DOR-673)
