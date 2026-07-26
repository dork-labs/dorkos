---
covers:
  - 'feat(approvals): the cookie bar and the store behind standing permissions (DOR-501)'
---

### Security

- Groundwork for standing permissions, the coming way to let one agent do one thing without being asked every time. Nothing is switched on yet, there is nothing to click, and DorkOS still asks you every time. What is already in place is the rule that will protect it: only a person signed in to DorkOS can change those settings. Being able to answer a single approval is not enough, so a program running on your machine cannot quietly give itself a free pass that lasts for hours. When the feature arrives it will need local login to be on, because without a sign-in DorkOS cannot tell you apart from an agent on the same machine (DOR-501)
