### Changed

- Crash reports, if you turn them on, now go to dorkos.ai instead of a third-party service. They are scrubbed the same way as before (no error messages, no file paths, no code, no session content) and stay off until you switch them on. There is no longer anything to set up: the old `SENTRY_DSN` step is gone, so the single `telemetry.errorReporting` switch is all it takes. Crashes in the cockpit itself are now reported too, and preview a report any time with `DORKOS_TELEMETRY_DEBUG=1`.
