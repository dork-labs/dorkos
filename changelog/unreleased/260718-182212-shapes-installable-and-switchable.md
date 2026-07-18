### Added

- **Shapes: install a whole setup, not just a tool.** Shapes are a new kind of marketplace package (DOR-355). A plugin adds one capability. A Shape describes a complete working setup: which extensions to turn on, how the dashboard and sidebar are arranged, a suggested agent, and the schedules that keep it running. This release ships the engine; the in-app Shape switcher arrives in a later release.
  - Install a Shape from the marketplace like any other package. The install-shape flow makes Shapes installable with the same safety net as plugins: a failed install cleans up after itself completely. (DOR-355)
  - Apply an installed Shape through the API (`POST /api/shapes/:name/apply`). The apply-shape service is idempotent, with per-piece degradation: anything missing (an extension, an agent, an API key) never blocks the rest. It shows up as a warning instead. (DOR-355)
  - Fork a Shape to make your own version, with a "forked from" lineage trail, using the new `dorkos shape fork` command. (DOR-355)
  - Shape-aware conflict detection, validator coverage for Shape manifests, and a scaffold command that generates a valid starter skeleton to build your own Shape from. (DOR-355)
  - Shape names are checked before use, capture forks stay valid even when an extension is turned off, and re-apply never creates duplicate schedules. (DOR-355)
