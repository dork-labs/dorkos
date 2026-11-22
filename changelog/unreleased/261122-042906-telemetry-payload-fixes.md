---
covers:
  - 'fix(telemetry): send the source type with marketplace install events (DOR-4988)'
  - 'fix(telemetry): keep usage events out of PostHog person profiles (DOR-4989)'
  - 'fix(telemetry): never send what you typed in a failed install event (DOR-4988)'
  - 'fix(telemetry): read the account-link state for usage events in one tested place (DOR-4989)'
---

### Fixed

- If you share install data, installs and updates from the marketplace now reach dorkos.ai. Before, every one was refused because a required field was missing, and shapes were refused too. An install that fails before DorkOS finds the package no longer sends the path or link you typed (DOR-4988)
- If you share usage data, those events no longer build a profile of you on dorkos.ai's analytics. They stay anonymous unless this computer is linked to an account and you chose to link your analytics to it (DOR-4989)
