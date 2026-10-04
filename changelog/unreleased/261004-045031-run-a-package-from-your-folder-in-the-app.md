---
covers:
  - 'wip(marketplace): dev link app surfaces, checkpoint (DOR-2696)'
  - 'feat(marketplace): show dev links in the app, with tests (DOR-2696)'
  - 'feat(marketplace): Dev Playground showcase for dev links (DOR-2696)'
  - 'test(e2e): link a folder, see the dev link badge, unlink (DOR-2696)'
  - 'docs(marketplace): guide to developing a package with a dev link (DOR-2696)'
  - 'fix(marketplace): drop a stale dev link reload, match project links by folder, and honest approval copy (DOR-2696)'
  - 'chore(docs): regenerate the docs coverage map for the dev link guide (DOR-2696)'
---

### Added

- Run a plugin or skill pack from your own folder while you build it, right from the app (DOR-2696). Go to Marketplace, then Installed, and choose Link a folder. The card shows the folder and everything it runs before you link it.
- A linked package shows a Dev link tag and its folder on the Installed list, in Browse, on its extensions in Settings, and on any page it adds. Its row says when your last edit reloaded, shows the build error when one didn't, and tells you when the folder is missing.
- Switch back from the same row. Use installed copy brings back the copy you had installed, Install published version gets the one from the marketplace, and Unlink removes it. Your folder is never touched.
