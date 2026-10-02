---
covers:
  - 'fix(relay): confine webhook address ownership and reserve document subjects'
---

### Security

- Keep webhook connections from taking over an agent's message address. Refuse conflicting addresses and keep similar-looking addresses separate. (DOR-2660)
