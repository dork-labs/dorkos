### Added

- Your agents can now ask a running DorkOS "what can I do here?" and get a live answer. A new `dorkos capabilities` command (add `--json` for raw output), a `list_capabilities` tool inside sessions and for external clients, and a `dorkos://capabilities` resource all return the same up-to-date catalog: every action available on this instance, with a short description of each. Agents no longer have to guess from static docs (DOR-442)
