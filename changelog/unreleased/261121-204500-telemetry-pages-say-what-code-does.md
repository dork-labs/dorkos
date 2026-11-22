---
covers:
  - 'fix(site): keep search words and error text out of dorkos.ai analytics (DOR-4992)'
  - 'fix(site): take search words out of page addresses and error frames in dorkos.ai analytics (DOR-4992)'
---

### Fixed

- dorkos.ai analytics no longer records what you searched for or the text of a page error. Page addresses keep only the marketplace's type and category filters. The marketplace visit notes whether a search was active and roughly how many packages matched. A page error notes only its type and where in the code it happened (DOR-4992)

### Changed

- The telemetry and privacy pages now say exactly what DorkOS does. They list what `DO_NOT_TRACK=1` stops and what it does not, and say that usage events, crash reports and AI run summaries pass through dorkos.ai to PostHog. They also explain that one install id is kept and shared by every channel and by feedback, what linking analytics to your account joins together, and that a bare `dorkos telemetry enable` turns on crash reports too (DOR-4994)
