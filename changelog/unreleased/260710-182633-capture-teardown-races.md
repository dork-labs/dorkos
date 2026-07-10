### Fixed

- The product-media capture pipeline now starts and stops cleanly between runs. It fully stops its test server and browser when a run ends, exits right after publishing instead of occasionally hanging, and — if a previous run left something holding its ports — either clears its own leftovers or stops with a clear message instead of quietly recording against the wrong server.
