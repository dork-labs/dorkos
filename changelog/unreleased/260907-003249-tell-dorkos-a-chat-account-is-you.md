---
covers:
  - 'feat(server,client,db,shared): tell DorkOS a Telegram account is you (DOR-1778)'
  - 'test(server,client): pin the claim’s coverage gaps and say why a claim was refused (DOR-1778)'
---

### Added

- You can now tell DorkOS that an account on another platform is you, and it stops notifying you about your own messages. Text your agent from your own phone and DorkOS used to buzz you about what you had just written — and again if you typed your own `@handle`. Open Team, find yourself on the platform you write from, and press "This is me"; press "Not me" to take it back. It only changes whose words DorkOS thinks those are — that account still gets nothing else on your machine, and only you can set it (DOR-1778)
