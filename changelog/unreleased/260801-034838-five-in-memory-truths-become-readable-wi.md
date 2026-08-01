---
covers:
  - 'feat(observability): five in-memory truths become readable without a restart'
---

### Added

- New: `dorkos debug` answers the questions you can only ask while DorkOS is running. Which agents are working right now and for how long, what was recently declined and why, which conversations have a live connection, and whether a room's agents still have their history on disk. It reads ids, counts and times — never the text of anything anyone wrote — and stores nothing. Run `dorkos debug --help` to see the subjects.
