---
covers:
  - 'fix(client): give the setup screen a way out, and make Settings shortcuts land on the right tab (DOR-481, DOR-484)'
---

### Fixed

- The first-run setup screen now has a way out. If DorkOS did not find a coding
  agent on your machine, the screen used to leave you stuck: nothing to
  continue with, and no Skip or Back to press. It now offers "Skip all setup"
  and Back, so you can look around the app first and set up an agent when you
  are ready — the Getting started card will still offer it (DOR-481)
- Buttons that say they will take you to a setting now take you to that
  setting. "Add more agents", "Open Relay settings", "Add an integration" and
  the guided tours all opened Settings on the Appearance tab instead of the one
  they named, leaving you to hunt for it yourself (DOR-484)
