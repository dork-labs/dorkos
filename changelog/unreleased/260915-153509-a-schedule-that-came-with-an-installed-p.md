---
covers:
  - 'fix(tasks): a schedule that came with an installed package can be approved and switched on (FB-26)'
  - 'fix(tasks): a package schedule stays switched the way a person left it across a package update (FB-26)'
  - 'fix(tasks): a paused schedule never reads as switched on, and switching one back on is recorded (FB-26)'
---

### Fixed

- You can now approve a schedule that came with an installed package, and switch it on or off. Clicking Approve used to fail with an error saying DorkOS would not change the package's files. Your choice stays put when the package updates, and changing what the schedule does still means editing the package (FB-26)
