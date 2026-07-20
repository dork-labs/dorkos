### Fixed

- Shapes you install now show up in the marketplace's Installed view, where you can uninstall or update them just like plugins and agents. Until now an installed Shape was missing from that list even though the install had worked.
- Updating the Shape you're currently in keeps you in it: the new version is re-applied automatically, instead of the update silently dropping your cockpit back to no Shape at all.
- Uninstalling the Shape you're currently in now clears it cleanly, instead of leaving your cockpit pointed at a Shape that's no longer there.
- The install preview for a Shape now shows the real folder its files will land in (`shapes/`), not a `plugins/` path the install never writes to.
