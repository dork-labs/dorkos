---
covers:
  - 'feat(connectors): let one app be used by every agent, including agents added later (DOR-2420)'
  - 'fix(connectors): be honest about every-agent access everywhere it applies (DOR-2420)'
  - 'fix(connectors): keep every-agent review facts and the Activity trail true (DOR-2420)'
  - 'feat(connections): offer "Every agent" in the page access card (DOR-2420)'
  - 'fix(connections): show every-agent access as it is, with a real warning (DOR-2420)'
  - 'fix(connections): say when every agent could delete, too (DOR-2420)'
---

### Added

- An app can now be shared with every agent at once, including agents you add later, for exactly the actions you picked: choose **Every agent** under "Who can use it?" when you connect an app. If every agent could send, change or delete things as you, DorkOS says so before you save. New actions an app adds later still stay off until you allow them. Stopping the sharing takes effect for every agent at once, even one in the middle of a task, and works even while the app's service is down (DOR-2420).
- When you create an agent, or add one from the Marketplace, DorkOS says what it will get from apps shared with every agent before you create it, for example "Research Bot will get: Gmail (read)". An agent that arrives any other way gets a line in Activity saying what it can use (DOR-2420).
