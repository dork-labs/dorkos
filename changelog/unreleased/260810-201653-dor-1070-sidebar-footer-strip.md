---
covers:
  - 'feat(client): the sidebar footer is one strip, and ✦ Ask DorkBot opens a session that already knows the situation (P2.5, DOR-1070)'
  - 'docs(contributing): the three guides that still describe the footer bar describe the footer strip (P2.5, DOR-1070)'
  - 'fix(client): the footer strip folds your account and help into its ⋯ menu, and its browser guard can see a fifth destination (P2.5, DOR-1070)'
---

### Changed

- The bottom of the sidebar is one slim strip now. It used to spend three rows on a logo, a
  row of icons and a version number; it spends one on the four places DorkOS goes — Home,
  Team, Marketplace, Connections — and a new **✦ Ask DorkBot** button. Your account, Settings,
  the theme switch, help and feedback, and the developer tools all moved one press away, into
  the **…** menu beside them.
- The version number left the chrome. When a new version is genuinely waiting, a small
  "Update ready" pill appears above the strip and disappears once you have it — and it never
  shows up in the Now zone, which is for agents that need you (DOR-1070)

### Added

- **Ask DorkBot** opens a fresh conversation with DorkBot that already knows the situation:
  which page you were on, how many agents you run, which version you are on and which
  conversations just failed. None of it is typed for you — the box you land in is empty and
  waiting, and DorkBot simply starts out knowing where you came from. If something cannot be
  worked out, it is left unsaid rather than guessed (DOR-1070)
