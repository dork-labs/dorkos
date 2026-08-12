---
covers:
  - "fix(client): the sidebar's suggestion cards lose their boxes, and Home goes to the first row (DOR-1138)"
  - 'fix(client): the day-one invitation loses its dashed box too (DOR-1138)'
---

### Changed

- The suggestion cards at the bottom of the sidebar now sit on the same soft tint as everything
  else in the panel, instead of being drawn inside their own outlined boxes. The sidebar has no
  lines in it anywhere now — things are told apart by shade and space (DOR-1138)

### Fixed

- Pressing **Home** in the sidebar now takes you to the first item in the list rather than to the
  section title above it, which is what **End** already did at the other end. To reach the title,
  press the up arrow once from the first item (DOR-1138)
