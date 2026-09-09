---
covers:
  - 'fix(harness): a folder in the way blocks one write, never all (DOR-1882)'
  - 'fix(harness): a hostile tree is read, not thrown out of (DOR-1882)'
  - 'fix(harness): an unreadable skills folder stops the sweep (DOR-1882)'
  - 'fix(harness): a read-only folder is named, not hit at write (DOR-1882)'
  - 'fix(harness): a generated file is written on a difference, not always (DOR-1882)'
---

### Fixed

- If a plain file sits where DorkOS needs a folder — a `commands` file where your agent tool keeps a commands folder, say, or a folder nobody has permission to read or write in — syncing your agent files no longer stops partway through with an error. It sets up everything the folder is not in the way of, leaves the folder exactly as you left it, and lists the one thing it could not do with a line naming the folder and how to clear it. Checking first says the same thing, so you are never told to run a fix that was going to refuse (DOR-1882)
- If DorkOS cannot read the folder your skills live in, it now leaves every skill shortcut alone instead of treating the folder as empty and tidying them away. It says which folder it could not read and that it removed nothing, so a folder with the wrong permissions costs you a warning rather than your skills (DOR-1882)
- Syncing no longer rewrites the command files DorkOS generates when nothing about them has changed. Only the ones that are actually different get written, so your editor and your agent tools stop being told a file changed when it did not — and a folder you have made read-only no longer turns a sync that had nothing to do into an error (DOR-1882)
