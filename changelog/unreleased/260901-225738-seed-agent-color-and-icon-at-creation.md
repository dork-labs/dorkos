---
covers:
  - 'feat(server,shared,client,mesh): seed a color and an emoji face onto every new agent (DOR-949)'
  - 'fix(client,server,shared,mesh): let the seeded face reach the agents the app creates (DOR-949)'
---

### Added

- New agents now show a face. Each one gets its own color and emoji the moment you make it, so your team reads as a row of characters instead of a row of letters (DOR-949)
- An agent you install from the marketplace now arrives wearing the face its author gave it (DOR-949)

### Changed

- Picking a color or an emoji yourself still wins. The app only fills in the half you left blank, and it never changes a face you already set (DOR-949)
- Clearing a color or emoji now puts back the face the agent started with, instead of a different one (DOR-949)
