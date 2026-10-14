---
covers:
  - 'feat(telemetry): carry an install tag from the install command to the first run (DOR-2862)'
  - 'feat(site): add an install tag to copied install commands and join it to the first run (DOR-2862)'
  - 'fix(telemetry): the install tag is a plain label, and turning usage off stops it at once (DOR-2862)'
---

### Added

- If you turn on feature-usage data, DorkOS now also says when you finish or skip setup, and once a day that it is running. Both are off until you turn that channel on, like every other event, and stop the moment you turn it off.
- An install command copied from dorkos.ai can now end with a short install tag, like `--ref=k3j4mnb8x2qa.hn`. It is a random code made for that one copy, plus the campaign tag of the link you came from. DorkOS keeps it on your computer and sends it only with the "finished setup" event, only when feature-usage data is on. The tag is only a label on two events; it never links the app to a website visitor or an account. The website adds a tag only for visitors who allow analytics cookies and do not send Do Not Track or Global Privacy Control. The privacy and telemetry pages say exactly what it holds.
