---
covers:
  - "fix(client): keep Home's top bar inside its row at tablet width with a big team (DOR-1816)"
---

### Fixed

- On a tablet-sized window with the sidebar open, Home's top bar no longer runs past its edge when your team has ten or more agents. The status light used to slide under the button beside it, and it got worse with every extra digit in the team count. When the bar is that narrow, the Stop button now shows only its icon. Its tooltip and its label for screen readers still say what it stops (DOR-1816)
