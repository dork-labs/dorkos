---
covers:
  - "fix(canvas): opening a file outside the agent's folder on the canvas says so, instead of showing nothing (DOR-3519)"
---

### Fixed

- When an agent tried to show you a file from outside its own folder, it was told the canvas opened, but you saw an empty pane. Now the agent gets an error that names the file and tells it to copy the file into its folder first, so it won't tell you something is open when it isn't. (DOR-3519)
