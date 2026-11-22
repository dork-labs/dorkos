---
covers:
  - 'fix(telemetry): send the source type with marketplace install events (DOR-4988)'
  - 'fix(telemetry): keep usage events out of PostHog person profiles (DOR-4989)'
---

### Fixed

- If you share install data, installs, updates and removals from the marketplace now reach dorkos.ai. Before, every one was refused because a required field was missing, and shapes were refused too (DOR-4988)
- If you share usage data, those events no longer build a profile of you on dorkos.ai's analytics. They stay anonymous unless this computer is linked to an account and you chose to link your analytics to it (DOR-4989)
