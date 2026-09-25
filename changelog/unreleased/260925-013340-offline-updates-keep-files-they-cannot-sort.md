---
covers:
  - "feat(server): an older install's rebuild tries the strict rule first and names what it could not prove (DOR-2322)"
  - "feat(server): an update that can't prove an older install's files keeps each one, names it and remembers it (DOR-2322)"
  - 'feat(server): uninstalling an older install nothing proves keeps those files and names them (DOR-2322)'
  - 'feat(server): Check files sorts what an update kept unproven, and a guessed record counts as unchecked (DOR-2322)'
  - 'feat: the app, the CLI and doctor name the files an update kept unproven, and offer Check files (DOR-2322)'
  - 'fix(server): the kept-files list lasts through later updates and uninstalls, and says which kept files still run (DOR-2322)'
  - 'fix(server): Check files sets leftovers aside as .dork-old instead of deleting them (DOR-2322)'
  - 'feat: kept files that still run are named apart, in the stronger weight (DOR-2322)'
  - 'fix(server): a kept file that still runs never rides a global approval, and the held-back note names it (DOR-2322)'
---

### Fixed

- Updating or removing a package that an older DorkOS installed no longer guesses which files are yours when DorkOS can't get the version you had, for example because you're offline. It keeps every file it can't account for and tells you which ones. After an update, the package says **Kept 2 files DorkOS couldn't sort after an update**, and you can open it to see them. Once you're online, **Check files** sets aside the ones that are exactly what the earlier version shipped, renaming each to end in `.dork-old` so it no longer runs, and keeps the rest as yours. Nothing is deleted. The package keeps listing the kept files through later updates until you check them, and says which of them still run, such as an old skill or command. A package installed for all projects that still runs such a file waits for your approval instead of loading, and says why. `dorkos marketplace installed --verify`, `update --apply`, `uninstall` and `dorkos doctor --deep` say the same (DOR-2322)
