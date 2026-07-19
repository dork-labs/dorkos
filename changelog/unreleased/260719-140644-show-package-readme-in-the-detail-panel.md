### Added

- See what a package does before you install it — the marketplace detail panel now shows each package's README right below its permissions.

### Fixed

- The README preview reads package files safely — a symlinked or oversized README can't leak your local files or eat memory (the read is capped at 200 KB and symlinks are rejected).
