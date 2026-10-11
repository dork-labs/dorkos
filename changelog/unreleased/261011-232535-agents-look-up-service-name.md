---
covers:
  - 'fix(operating-skills): look up a service's exact name before requesting it (DOR-2236)'
---

### Fixed

- When an agent asks you for access to a service, it now looks up that service's exact name first, so the request names the right app. Agents are also told that signing in to a service's command-line tool gives DorkOS no access (DOR-2236)
