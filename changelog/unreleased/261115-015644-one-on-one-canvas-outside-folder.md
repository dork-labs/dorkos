---
covers:
  - "fix(canvas): a one-on-one chat's canvas refuses a file from outside the agent's folder, and says so (DOR-3519)"
---

### Fixed

- In a one-on-one chat, the canvas only shows files from the agent's own folder. An agent that tries to open another file there now hears so, by name, and is told it can still read the file and show you what's in it, or copy it into its folder. Before, it was told the file was open while you saw an empty card.
