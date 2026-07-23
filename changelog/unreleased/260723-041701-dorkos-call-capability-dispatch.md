### Added

- New `dorkos call <capability-id>` command: invoke any DorkOS capability by id from the command line and get the result as JSON. Pair it with `dorkos capabilities` to discover what's available, then call one with `--input '{...}'` (or `--input-file`). Unknown ids and invalid input come back as clear errors. This gives an agent in any runtime a single, uniform way to drive DorkOS (DOR-443)
