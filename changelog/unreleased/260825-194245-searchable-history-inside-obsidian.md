---
covers:
  - 'fix(obsidian-plugin): the __dirname rewrite survives a minified bundle (DOR-1563)'
  - 'fix(db): the migrations folder resolves when asked, not when imported (DOR-1563)'
  - 'feat(obsidian-plugin,server): the embed reads the message index it searches (DOR-1563)'
---

### Fixed

- The DorkOS plugin for Obsidian builds a bundle that can actually start. Two things in it were broken before the plugin got as far as loading: a patch the build applies missed some of the code it was meant to cover once the bundle was minified, and the database library worked out a file path the moment it was loaded rather than when it was needed. Both are fixed, and the build now stops with a message naming what it missed instead of quietly producing a plugin that throws on startup (DOR-1563)

### Added

- The plugin build now packages SQLite alongside the plugin, picking the build that matches whichever Obsidian you run it on. Every one of them is checked against a recorded fingerprint each time it is used — not just the first time it is downloaded — so bytes that are not what they claim to be stop the build instead of shipping (DOR-1563)
- The plugin now carries the rest of what searching your history needs: a strictly read-only path to the copy the DorkOS app keeps. Read-only is the guarantee, not a detail — it will not create a database, change one, or add to one, so it can never disagree with the DorkOS app about your own data. Where there is nothing to read, it stays out of the way rather than quietly finding nothing (DOR-1563)
- Anything read that way respects exactly the same limits as the DorkOS app. If your DorkOS asks people to sign in, the plugin works out who owns it from the database rather than assuming it is you (DOR-1563)
