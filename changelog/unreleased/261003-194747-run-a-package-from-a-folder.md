---
covers:
  - 'feat(marketplace): dev-link registry, parked marker and DevLinkService (DOR-2696)'
  - 'feat(marketplace): no trust crosses between a dev link and an installed copy (DOR-2696)'
  - 'feat(marketplace): the marketplace.link capability, MCP tool and dev-link routes (DOR-2696)'
  - 'test(marketplace): read the dev-link source pin through the shared lexer (DOR-2696)'
  - 'fix(marketplace): bind the dev-link card to what it showed, and harden link and unlink (DOR-2696)'
  - 'fix(marketplace): hold marketplace_link to the exact text the person approved (DOR-2696)'
  - 'fix(marketplace): bind the whole dev-link card, and refuse one that does not fit (DOR-2696)'
---

### Added

- An agent can ask to run a plugin or skill pack from a folder on your computer instead of an installed copy (DOR-2696). You approve it on a card, and nothing runs from the folder until you do.
- The card shows the folder's full path and the extensions it would run. No permission setting can approve it ahead of time, and a folder that changes before you answer is asked about again.
- If you already have that package installed, the installed copy is set aside, not deleted.
