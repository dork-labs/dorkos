### Added

- Drive DorkOS from the command line: new `dorkos agent`, `dorkos task`, `dorkos activity`, and `dorkos version --check` commands. List, inspect, and create agents; list, create, and trigger scheduled tasks; read the activity feed; and check the running server's version against the latest release (it still answers from a local cache when no server is running). Every command takes `--json` for clean, machine-readable output, so an agent in any runtime can operate DorkOS through the terminal. Run any command with `--help` for its options (DOR-434)
