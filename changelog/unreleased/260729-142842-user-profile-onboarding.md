---
covers:
  - 'feat(onboarding): DorkBot asks what kind of work you do, and every agent knows who it works for (DOR-705)'
---

### Added

- DorkBot now asks what kind of work you do, right after you pick its personality during setup. Answer with a tap or type your own, or skip it and never be asked again. Your answer stays on this machine: it goes to your own agents so they know who they work for, and it is never included in any telemetry payload. Tests hold that line. Every agent session now opens knowing your name, your work, and your tools, once you have shared them. If you set up DorkOS before this question existed, DorkBot asks once in the sidebar, with a one-tap "Don't ask again". (DOR-705)
- After you answer, DorkBot suggests a couple of services that fit your work, like Gmail and Greenhouse for hiring. One line, no setup pushed on you. (DOR-705)
