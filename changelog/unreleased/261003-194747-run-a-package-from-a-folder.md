---
covers:
  - 'feat(marketplace): dev-link registry, parked marker and DevLinkService (DOR-2696)'
  - 'feat(marketplace): no trust crosses between a dev link and an installed copy (DOR-2696)'
  - 'feat(marketplace): the marketplace.link capability, MCP tool and dev-link routes (DOR-2696)'
---

### Added

- Run a plugin or skill pack straight from a folder on your computer while you build it, with no reinstall for each change (DOR-2696). For now an agent asks for it, and you approve it on a card.
- The card shows the folder's full path every time, and no permission setting can approve it ahead of time.
- If you already have that package installed, the installed copy is set aside, not deleted, and its approvals are kept for when you switch back.
