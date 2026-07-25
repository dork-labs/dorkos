---
covers:
  - 'fix(onboarding): skip one step instead of the whole flow (DOR-472)'
  - 'fix(onboarding): make the way back from Skip all setup one click (DOR-472)'
  - 'fix(onboarding): give the whole-flow exit a keyboard focus ring (DOR-472)'
---

### Fixed

- In first-run setup, "Skip" no longer throws away the rest of setup. Choosing a personality for DorkBot now has its own "Skip this step" button that moves you to the next thing, and the button that leaves setup for good says so: "Skip all setup". If you do leave, a note tells you where to start setup again (Settings → Preferences) (DOR-472)
