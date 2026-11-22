---
covers:
  - 'fix(telemetry): DO_NOT_TRACK also stops update checks and runtime telemetry (DOR-4990)'
  - 'fix(telemetry): pass DISABLE_ERROR_REPORTING to runtimes and widen the outbound census (DOR-4990)'
  - 'fix(telemetry): run the outbound census in the merge queue and review every dependency (DOR-4990)'
---

### Security

- Setting `DO_NOT_TRACK=1` or `DORKOS_TELEMETRY_DISABLED=1` now also turns off the DorkOS server's check for a newer version, and the same check in the `dorkos` command. The desktop app's own updater still checks for new versions. With either set, DorkOS passes `DO_NOT_TRACK=1`, `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1` on to Claude Code, Codex and OpenCode. (DOR-4990)
- The `dorkos` command now honours `DORKOS_UPDATE_CHECK_DISABLED=1`, the same switch the DorkOS server already had. (DOR-4990)
- On the Mac app, a `DO_NOT_TRACK` you set in your shell's startup file now reaches DorkOS too. Before, only a terminal start picked it up. (DOR-4990)
