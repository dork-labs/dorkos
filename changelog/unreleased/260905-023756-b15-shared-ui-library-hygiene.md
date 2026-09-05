---
covers:
  - 'fix(client): UI audit batch 15 — shared/ui library hygiene (DOR-1761)'
---

### Fixed

- Buttons no longer submit a form by accident when all they were asked to do is run a click (DOR-1761)
- Checkboxes and radio dots now grow on a phone, like the text boxes beside them already did (DOR-1761)
- A switch given a size now still grows on a phone; asking for both used to quietly do nothing (DOR-1761)

### Changed

- Most controls in the app now measure size the same way — extra small, small, medium, large — so two controls side by side usually line up (DOR-1761)
