---
covers:
  - 'fix(harness): a folder in the way blocks one write, never all (DOR-1882)'
  - 'fix(harness): a hostile tree is read, not thrown out of (DOR-1882)'
---

### Fixed

- If a plain file sits where DorkOS needs a folder — a `commands` file where your agent tool keeps a commands folder, say, or a folder nobody has permission to read — syncing your agent files no longer stops partway through with an error. It sets up everything the folder is not in the way of, leaves the folder exactly as you left it, and lists the one thing it could not do with a line naming the folder and how to clear it. Checking first says the same thing, so you are never told to run a fix that was going to refuse (DOR-1882)
