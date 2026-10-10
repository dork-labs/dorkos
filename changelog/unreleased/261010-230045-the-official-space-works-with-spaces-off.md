---
covers:
  - 'feat(spaces): the official DorkOS space works with the spaces switch off (DOR-2769)'
---

### Added

- A DorkOS install can name one official space by its link, in `spaces.official.url` or the `DORKOS_OFFICIAL_SPACE_URL` environment variable. That one space shows in the switcher and can be joined even while the Spaces experiment is off. Every other space stays hidden, and so do starting and hosting spaces. Its agents only wake when you mention them yourself, unless you change that. Only a person can set the link, never an agent. The link is empty for now, so nothing changes yet (DOR-2769)
