---
covers:
  - 'feat(settings): turn background systems off, honestly — and a welcome-back switch (team-room-home 4.6 + the 4.3 toggle)'
---

### Added

- Settings → Tools has a new **Background systems** section with one switch for scheduled runs
  and one for agent messaging. Turning a switch off stops DorkOS from starting that system, and
  its tools go quiet with it. Until now the only way to do that was to hand-edit your config
  file. DorkOS starts these systems once, when it starts, so the row says plainly that your
  change takes effect the next time DorkOS starts rather than pretending it already has. If a
  `DORKOS_TASKS_ENABLED` or `DORKOS_RELAY_ENABLED` variable is set in the server's environment,
  the switch says so and stays locked, because that variable is what decides.
