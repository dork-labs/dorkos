---
covers:
  - 'feat(tasks): read schedule ownership from the installed-files record (DOR-2272)'
  - 'feat(tasks): offer Make my own copy when an edit to a package schedule is refused (DOR-2272)'
  - "fix(tasks): spell the copy notice's apostrophe the house way (DOR-2272)"
  - "fix(tasks): keep a person's switch when a file stops being a package's (DOR-2272)"
  - 'feat(tasks): show package ownership when a schedule opens, and switch the original off with a copy (DOR-2272)'
---

### Added

- You can now make schedules for an agent you installed from the marketplace, the same way as for any other agent, and they are kept when the package updates. Until now DorkOS turned every one of them down. Two cases are still refused, each with a note saying why: a name the package already uses for one of its own schedules, and any schedule for an agent whose package was installed by an older version of DorkOS, which works after that package's next update (DOR-2272)
- A schedule that came with a package now says so as soon as you open it. You can still switch it on or off and change when it runs; its name, instructions and settings are shown but can't be changed there, because the package's next update would put them back. **Make my own copy** opens a new schedule for the same agent with everything filled in and a name that isn't taken yet. By default, creating the copy also switches the package's schedule off, so the same work doesn't run twice (DOR-2272)

### Fixed

- A package schedule you had switched off no longer switches itself back on when the package stops including it. DorkOS now keeps your choice and writes it into the schedule's file, which is yours from then on (DOR-2272)
