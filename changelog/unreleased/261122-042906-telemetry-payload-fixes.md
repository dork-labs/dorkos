---
covers:
  - 'fix(telemetry): send the source type with marketplace install events (DOR-4988)'
  - 'fix(telemetry): keep usage events out of PostHog person profiles (DOR-4989)'
  - 'fix(telemetry): never send what you typed in a failed install event (DOR-4988)'
  - 'fix(telemetry): read the account-link state for usage events in one tested place (DOR-4989)'
  - 'fix(telemetry): send placeholders for folder installs and unknown marketplaces (DOR-4988)'
  - 'fix(telemetry): start usage data the moment you turn it on, so a first run is counted (DOR-5018)'
---

### Fixed

- If you share install data, installs and updates from the marketplace now reach dorkos.ai. Before, every one was refused because a required field was missing, and shapes were refused too. An install that fails before DorkOS finds the package no longer sends the path or link you typed, and an install from a folder on your computer no longer sends the folder's name (DOR-4988)
- If you share usage data, those events no longer build a profile of you on dorkos.ai's analytics. They stay anonymous unless this computer is linked to an account and you chose to link your analytics to it (DOR-4989)
- If you turn on usage data while DorkOS is running, it starts right away instead of after the next restart. On a new install, that means finishing setup is now counted once (DOR-5018)
