---
covers:
  - 'fix(server): task edits recognize agent- and Shape-package files as package-owned (DOR-1789)'
---

### Fixed

- Editing a schedule that came from an installed agent or Shape no longer writes into that package's own files, where the change would have been shared with everyone who installed it and wiped out by the next update. DorkOS now says the schedule belongs to a package, the same as it already did for plugins — and schedules belonging to agents you made yourself stay yours to edit (DOR-1789)
- Adding a new schedule to an agent that came from the marketplace is now refused up front, instead of being accepted and then wiped out by that package's next update. DorkOS suggests making your own copy of the agent and putting the schedule there (DOR-1789)
