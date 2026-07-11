### Added

- DorkOS can now send a crash report to your own Sentry or self-hosted GlitchTip project when something breaks, so a bug can get fixed without anyone asking for your log files. It is off by default and is its own separate choice, never turned on by the anonymous-data banner. It sends only the error type and a cleaned-up stack trace (which function, file, and line), never the error message, your file paths, tokens, or anything from your sessions. To turn it on you set a `SENTRY_DSN` and flip `telemetry.errorReporting` to true. Full details on the telemetry page (DOR-293)
