---
covers:
  - 'fix(telemetry): DO_NOT_TRACK also stops update checks and runtime telemetry (DOR-4990)'
---

### Security

- Setting `DO_NOT_TRACK=1` or `DORKOS_TELEMETRY_DISABLED=1` now also turns off the check for a newer DorkOS, in the app and in the `dorkos` command. It also tells Claude Code, Codex and OpenCode to send no telemetry of their own. (DOR-4990)
- The `dorkos` command now honours `DORKOS_UPDATE_CHECK_DISABLED=1`, the same switch the app already had. (DOR-4990)
- On the Mac app, a `DO_NOT_TRACK` you set in your shell's startup file now reaches DorkOS too. Before, only a terminal start picked it up. (DOR-4990)
