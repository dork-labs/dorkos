---
covers:
  - 'feat(client): one EmptyState and one QueryErrorState for every panel (DOR-1763)'
  - 'refactor(client): one DetailRow for every label/value readout (DOR-1763)'
  - 'feat(client): the pill comes out of Badge, and the chip out of shared/ui (DOR-1763)'
  - 'refactor(client): the Card shell comes from Card (DOR-1763)'
  - 'refactor(client): one collapse gesture, one rename machine, one promo layout (DOR-1763)'
  - 'fix(client): the first-run Composio button stops stretching (DOR-1763)'
---

### Changed

- Empty panels and "couldn't load that" panels now look the same everywhere in the app, instead of a little different on each screen (DOR-1763)
- Panels that list facts — a session's id, a server's settings, your usage — line those facts up the same way on every screen (DOR-1763)
- Sections that slide open and shut now all move at the same speed. Before, opening a tool card and opening a task row were the same gesture at two different speeds (DOR-1763)

### Fixed

- Screen readers no longer read out loading spinners as unlabelled pictures (DOR-1763)
