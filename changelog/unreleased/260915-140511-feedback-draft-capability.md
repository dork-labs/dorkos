---
covers:
  - 'feat(server): agents can draft a bug report and hand you the link (DOR-2056)'
---

### Added

- Ask DorkBot to report a bug or ask for a feature, and it drafts the report and hands you a link to review and send. Nothing is sent for you: the link opens a GitHub issue page with your version, your OS, which agent runtimes you have set up and your on/off settings already written in, so you read it, change anything you would rather keep to yourself, and press submit. It is the same prefilled page the app's "Report a bug" menu and the `dorkos feedback` command open (DOR-2056)
