---
covers:
  - 'fix(site): keep search words and error text out of dorkos.ai analytics (DOR-4992)'
---

### Fixed

- dorkos.ai analytics no longer records the text of a page error, or the words of a search in the marketplace visit event. That event now notes only whether a search was active and roughly how many packages matched. A page error notes only its type and where in the code it happened (DOR-4992)

### Changed

- Correct the telemetry and privacy pages so they say exactly what DorkOS does. They now list what `DO_NOT_TRACK=1` stops and what it does not, say that usage events, crash reports and AI run summaries pass through dorkos.ai to PostHog, explain that the install id is kept and shared by every channel and by feedback, and explain what linking analytics to your account joins together (DOR-4994)
