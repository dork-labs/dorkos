---
covers:
  - 'feat(server,shared,db): a proposed schedule says who wants it, why, and when it would run (DOR-1394)'
---

### Added

- An agent that wants to run something on a timer now has to say why, in its own words. DorkOS keeps that reason with the proposal, along with which agent asked and the session it asked from, so there is something to read before you decide (DOR-1394)

### Changed

- The alert about a schedule waiting on you now names the agent that proposed it, instead of saying "An agent" (DOR-1394)
- A schedule waiting for your approval now says when it would actually run: the next time, and the two after it. Until now it said nothing, because DorkOS only worked that out for schedules that were already switched on, which is never true of one that is still waiting on you (DOR-1394)
