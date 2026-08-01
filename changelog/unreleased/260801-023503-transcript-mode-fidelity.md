---
covers:
  - "fix(server): a Claude session in auto or don't-ask no longer lists as default"
---

### Fixed

- The session list now shows the real permission mode for Claude sessions running in "Auto" or "Don't ask". Both used to be reported as "Default", which made an unattended session look like it was still asking before every tool.
