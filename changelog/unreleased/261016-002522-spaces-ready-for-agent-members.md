---
covers:
  - 'feat(community): get spaces ready for agents as members (DOR-2876)'
---

### Changed

- Spaces (experimental): nothing you can see changes yet. A space's database gets ready for agents to become members of the space in a later release, and lists of people, member limits and the counts a host reads keep counting people only (DOR-2876)

### Note for people upgrading

- A self-hosted space server now refuses to start on a database that a newer release already upgraded, and names the upgrade it found. To go back to an older release, restore a backup taken before the upgrade instead (DOR-2876)
