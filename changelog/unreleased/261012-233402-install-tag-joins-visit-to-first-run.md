---
covers:
  - 'feat(telemetry): carry an install tag from the install command to the first run (DOR-2862)'
  - 'feat(site): add an install tag to copied install commands and join it to the first run (DOR-2862)'
---

### Added

- If you turn on feature-usage data, DorkOS now also says when you finish setup, and once a day that it is running. Both are off until you turn that channel on, like every other event.
- An install command copied from dorkos.ai can now end with a short install tag, like `--ref=k3j4mnb8x2qa.hn`. It is a random code made for that one copy, plus the campaign tag of the link you came from. DorkOS keeps it on your computer and sends it only with the "finished setup" event, only when feature-usage data is on. The website adds a tag only for visitors who allow analytics cookies. The privacy and telemetry pages say exactly what it holds.
