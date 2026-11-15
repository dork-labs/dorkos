---
covers:
  - 'feat(connectors): a monthly spend limit on paid app actions, and a card only you can allow (DOR-4204)'
  - 'fix(connectors): a paid action reaches Telegram or Slack as words to answer in DorkOS, never a yes to tap (DOR-4204)'
---

### Added

- You can set a monthly limit on what agents spend through apps that charge per use. Paid actions within the limit run without asking. Until you set one, every paid action asks you first.
- At the limit, paid actions stop until next month or until you raise it. Raising the limit, or lowering an app's price, asks you to confirm it's you.
- You get a notice when agents have used 80% of the month's limit, and another when they reach it.
- A paid action never runs from a turn that read outside content, such as a message from someone outside your team.
- When a paid action waits on your yes, Telegram or Slack only tells you to answer in DorkOS. There's nothing to tap there.
