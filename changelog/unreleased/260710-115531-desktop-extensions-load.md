### Fixed

- Extensions now load in the desktop app. Before, the app quietly skipped them because it looked for them at the wrong address — every extension request went to the desktop window itself instead of the DorkOS server, so the extension system silently gave up on startup (DOR-243)
