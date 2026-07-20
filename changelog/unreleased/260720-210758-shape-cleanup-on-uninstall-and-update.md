### Fixed

- Uninstalling a Shape now removes the scheduled tasks it created. Before, those schedules kept firing forever after the Shape was gone, with no trace in the app to find or stop them. (#369)
- Updating a Shape now cleans up any scheduled tasks the new version dropped or renamed, so an old task can't keep running next to its replacement. (#369)

### Changed

- Switching from one Shape to another now turns off the previous Shape's extensions (unless the Shape you're switching to also uses them), instead of leaving every Shape's extensions piled on. Uninstalling the Shape you're currently in also turns its extensions back off. (#369)
