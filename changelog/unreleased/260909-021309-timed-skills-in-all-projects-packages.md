---
covers:
  - 'feat(harness): a global plan, pure, with the dork-home tier (DOR-1923)'
  - 'feat(harness): a global plan applies and sweeps only what it wrote (DOR-1923)'
  - 'test(harness): P8 exists, and P8b/P8c hold the global plan to its roots (DOR-1923)'
  - "feat(server): global rows in every project's status answer (DOR-1923)"
  - "feat(harness): a global package's timers are told they work (DOR-1923)"
  - 'feat(cli): dorkos harness sync --global (DOR-1923)'
---

### Added

- A skill that runs on a timer inside a package you installed for all your projects now actually runs. `dorkos harness sync --global` puts those skills where DorkOS looks for timed work, so a daily job in a package you installed once shows up for you to approve like any other. It works from any folder and needs no project (DOR-1923)
- Before it removes a link, `--global` prints every path it is about to remove, and prints them again once they are gone. It only ever removes links it made itself: a folder you made, or a link you made yourself, is left exactly where it is. Run it twice and the second run does nothing (DOR-1923)
- The Skills page now lists the skills in your all-projects packages alongside your project's own, marked as coming from every project, with the same sentence about who can see them (DOR-1923)

### Changed

- The line about a package installed for all your projects now ends with "Its skills that run on a timer now work" when the package has one. Packages with no timed skill say nothing new (DOR-1923)
