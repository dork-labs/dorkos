---
covers:
  - 'feat(community): say space on the space website and in the launcher output (DOR-2653)'
  - 'fix(community): call it a server account in the operator recovery tools (DOR-2653)'
---

### Changed

- A space's own website now says "space" everywhere you read it, the same word the DorkOS app uses: **Create space**, **Join space**, **Leave space**, **Spaces you left**, the page title, the emails it sends and the messages it shows. The page for the person who runs the server is now **Server administration**, and wherever the site said "host" it now says "server" or "server admin". Messages removed before this change keep their old wording and still show as removed. (DOR-2653)
- `dorkos community deploy` now says "space" in what it prints, for example "Space setup is complete at …". The command itself is unchanged. (DOR-2653)
