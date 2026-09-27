---
covers:
  - 'Give each Claude account a color, and keep its id safe to share with flow (DOR-2379)'
---

### Changed

- Each Claude account now has a color, used later for its dot and badge. Leave it empty and DorkOS picks one by the account's place in the list, so nothing looks different today (DOR-2379)
- If one of your Claude accounts was saved with the id `default`, DorkOS renames it to `default-2` when you upgrade. `default` now always means your main account. Agents and chats that pointed at the old account keep billing it (DOR-2379)
- Saving your Claude accounts in Settings no longer drops what flow or a hand edit added to your config file. Extra details on an account are kept, and so is an account entry DorkOS cannot use yet (DOR-2379)

### Fixed

- A Claude account entry with no folder or an empty id no longer makes DorkOS set your whole config file aside at startup. DorkOS skips that entry and notes it in the log (DOR-2379)
