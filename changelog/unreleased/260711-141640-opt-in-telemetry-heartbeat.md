### Added

- DorkOS can now send an anonymous weekly heartbeat so the project can roughly count how many people are actively running it. It is off by default and asks once, on first run, showing you the exact data before you choose. It only ever sends a random install id, the version, your OS and chip type, which runtimes you have on, whether the tunnel and cloud link are enabled, and rough counts. Never your prompts, code, file paths, or session content. There is a new page at dorkos.ai/telemetry that documents every field and how to opt in or out (DOR-293)

### Changed

- Telemetry consent is now one clear choice covering both the new heartbeat and the existing marketplace install stats, instead of a marketplace-only banner. Everything stays off until you say yes, and you can change your mind anytime in settings (DOR-293)
