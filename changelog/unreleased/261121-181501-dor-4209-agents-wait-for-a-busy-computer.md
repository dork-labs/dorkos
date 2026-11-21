---
covers:
  - 'feat(operating-skills): agents learn to wait in the line for heavy jobs (DOR-4209)'
---

### Added

- Every agent now has a skill about the line its builds, test runs and installs wait in while
  your computer is busy. It knows which commands wait and which run at once, that a wait is its
  place in line and not a hang, and that a run refused because the computer was too busy should
  be tried again later, not reported as a failure. It never works around the line, and it tells
  you in one line when a wait is holding up urgent work, so you can let that job through from the
  Activity page.
