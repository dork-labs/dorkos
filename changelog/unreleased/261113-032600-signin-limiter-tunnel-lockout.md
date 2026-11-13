---
covers:
  - 'fix(server): a stranger on the tunnel can no longer lock the owner out of sign-in (DOR-4227)'
---

### Security

- Through remote access, someone else's wrong passwords no longer stop you from signing in. Each device that reaches DorkOS that way now has its own limit on sign-in attempts.
