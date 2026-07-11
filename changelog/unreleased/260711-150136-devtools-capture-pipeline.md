### Added

- Groundwork for letting your agent see its own preview: when it opens a local page or a dev server in the workbench browser, DorkOS now captures that page's console messages and network requests behind the scenes. It stays private to your session and never leaves memory. The agent-facing part — reading those errors to fix its own work — lands next (DOR-213)
