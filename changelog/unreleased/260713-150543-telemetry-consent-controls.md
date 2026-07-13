### Added

- New ways to see and control what anonymous data DorkOS sends. A **Privacy & Data** tab in settings lets you flip each channel on or off, and the first-run onboarding now asks the same question with the exact payload shown. Nothing changed about the defaults: every channel is still off until you say yes.
- `dorkos telemetry status`, `dorkos telemetry enable`, and `dorkos telemetry disable` let you check and change telemetry from the command line. Use `--channel install|heartbeat|errors` to change just one.
- Two environment kill switches, `DO_NOT_TRACK` and `DORKOS_TELEMETRY_DISABLED`, force every channel off no matter what your config says. Set either to `1` and DorkOS sends nothing.
- A debug mode: set `DORKOS_TELEMETRY_DEBUG=1` and DorkOS prints the exact JSON it would send to your terminal instead of sending it, so you can read every field for yourself.
