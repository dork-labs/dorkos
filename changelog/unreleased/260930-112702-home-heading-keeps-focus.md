---
covers:
  - 'fix(client): keep focus on the Home heading after a narrow-window context switch (DOR-2613)'
---

### Fixed

- In a narrow window, switching from a Community back to your own DorkOS now leaves your place on the Home page's title, so a screen reader says "Home" and stays there. Before, the message box took over a moment later, and the next thing you heard was the name of a box you never picked (DOR-2613)
