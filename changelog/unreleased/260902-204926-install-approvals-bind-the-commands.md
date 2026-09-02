---
covers:
  - 'fix(server): an install approval binds the commands the person read (DOR-647)'
---

### Fixed

- When you approve an agent's request to install a marketplace package, that approval now covers the commands and scheduled jobs the card showed you — not just the package name. If the package changes between the moment you say yes and the moment it installs, DorkOS stops, tells you what the package declares now, and asks again — instead of quietly installing something you never read (DOR-647)
