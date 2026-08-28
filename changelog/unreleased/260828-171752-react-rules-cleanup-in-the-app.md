---
covers:
  - 'refactor(client): the render-time ref reads the new hooks lint found — chat, sidebar, mesh (DOR-1558)'
  - 'refactor(client): the setState-in-effect and impure-render reads the new hooks lint found (DOR-1558)'
  - 'refactor(client): the last of the new hooks-lint findings — forms, dialogs, latches (DOR-1558)'
  - 'refactor(client): drop the ten eslint-disable directives the fixes made unnecessary (DOR-1558)'
  - 'fix(client): the two stamps that could not tell a new value from an old one (DOR-1558)'
---

### Fixed

- The sidebar no longer flashes its phone layout for an instant when you widen the window (DOR-1558)
- Screen readers now hear the "1 minute left" warning on a permission request even when the tab
  was in the background and the clock skipped a second (DOR-1558)
