---
covers:
  - "fix(canvas): control_ui binds its verified caller as a page's opener on Claude Code"
---

### Fixed

- A Claude Code agent that opens a page in the canvas can now hear from that page. Before, the page opened but could never be connected back to the agent.
