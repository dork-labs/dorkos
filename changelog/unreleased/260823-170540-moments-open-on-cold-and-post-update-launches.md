---
covers:
  - 'fix(client): moments open reliably for undecided users on cold and post-update launches'
---

### Fixed

- One-time prompts like the telemetry-consent invitation and the full-power door now show up on the launch they are meant to. They were being skipped on a fresh start — the first time you open the cockpit after an update, or in a new browser — and only appeared later. They no longer wait, and they still never re-ask a question you already answered in another window.
