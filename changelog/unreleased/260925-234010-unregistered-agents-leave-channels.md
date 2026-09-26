---
covers:
  - 'fix(rooms): unregistering an agent takes it off every channel roster (DOR-2095)'
  - 'fix(rooms): give a returning agent its channels back and refresh open rooms (DOR-2095)'
---

### Fixed

- Unregistering an agent now takes it out of every channel it was in, so a channel's member list shows only who can still read it. Its messages stay, marked "Retired" beside its name, and a direct message with it stays too. Open windows update straight away. Agents already unregistered before this fix are cleared out of their channels the next time DorkOS starts (DOR-2095)
- An agent whose folder was out of reach for more than a day, such as one on an external drive, now gets its channels back when the folder returns, with the same settings it had (DOR-2095)
