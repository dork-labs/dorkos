---
covers:
  - "fix(client): keep Home's top bar inside its row at tablet width with a big team (DOR-1816)"
  - 'fix(client): step Stop out of a very narrow bar, and guard Home with remote access on (DOR-1816)'
---

### Fixed

- On a tablet-sized window with the sidebar open, Home's top bar no longer runs past its edge when your team has ten or more agents. The status light used to slide under the button beside it, and it got worse with every extra digit in the team count and when remote access was on. When the bar is narrow, the Stop button beside the working count now shows only its icon, and when it is narrower still it steps out of the bar. You can still stop every agent from the list of working agents above the message box (DOR-1816)
