---
covers:
  - 'fix(client): UI audit batch 15 — shared/ui library hygiene (DOR-1761)'
  - 'fix(client): data-slot on the shared/ui leaves that have a root of their own (DOR-1761)'
  - "style(client): prettier pass over batch 15, and OptionRow's data-selected wins (DOR-1761)"
  - "fix(client): the switch's responsive ladder must be literal, not built (DOR-1761)"
  - 'fix(client): address adversarial review findings for batch 15 (DOR-1761)'
---

### Fixed

- Buttons no longer submit a form by accident when all they were asked to do is run a click (DOR-1761)
- Checkboxes and radio dots now grow on a phone, like the text boxes beside them already did (DOR-1761)
- A switch given a size now still grows on a phone; asking for both used to quietly do nothing (DOR-1761)
- The live activity chip that shows what your agent is doing now keeps its gentle pulse when "reduce motion" is turned on, instead of going still (DOR-1761)

### Changed

- Most controls in the app now measure size the same way — extra small, small, medium, large — so two controls side by side usually line up (DOR-1761)
