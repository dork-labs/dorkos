---
covers:
  - 'feat(connections): set the monthly spend limit in Connections, and see which actions spend money (DOR-4204)'
  - "feat(db): the spend limit's tables, after main's latest migration, with a down file (DOR-4204)"
  - 'fix(connectors): a paid run the gate refuses is written to Activity, and only real changes to spending are recorded (DOR-4204)'
  - 'fix(connectors): only a yes on a paid-run card lets a run spend, and an agent with no session is checked for outside words (DOR-4204)'
---

### Added

- Connections has a Spending section. Set the monthly limit there, see how much agents spent this month, and which apps it went to.
- Actions that cost money now say "Spends money", with a coins icon, in the app's action list and on its row in Connections.
- For an app that charges per use, you can set your best guess of what one run costs on its page. The limit counts each run at that price.
- When an agent's paid action needs your yes, the card shows what it costs and how much is left this month. It offers Allow once and Don't allow.
