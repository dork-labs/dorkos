---
covers:
  - 'fix(harness): a package whose manifest will not parse is named, not vanished (DOR-1933)'
  - 'fix(harness): a skill folder DorkOS cannot look inside keeps its links (DOR-1935)'
  - "fix(server,tasks): a packaged skill's schedule ends when its link does (DOR-1934)"
---

### Fixed

- Tell you when a package you installed has a file DorkOS cannot read, instead of leaving it out
  of every report. `dorkos harness sync` now names the package and the file, and says that the
  skills it had already shared were left where they are (DOR-1933)
- Keep sharing a skill whose folder DorkOS cannot open — a folder whose permissions changed, or
  one that is halfway through being deleted. DorkOS used to treat it as a skill you had removed
  and take its links away without a word; now it leaves everything alone and tells you which
  folder to look at (DOR-1935)
- Stop a timer running for a skill that is no longer there. Uninstalling a package used to leave
  its scheduled skill on the clock forever; DorkOS now pauses it in the same pass, whether the
  package went or only the link to it (DOR-1934)
