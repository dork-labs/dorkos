---
covers:
  - 'fix(server,shared,test-utils): key sign-in episodes by the account a turn ran on (DOR-1682)'
---

### Fixed

- If you run more than one Claude account, DorkOS now knows which one a broken
  sign-in belongs to. Work on a healthy account used to clear the alert about a
  dead one within seconds, over and over, which also cancelled the reminder that
  would have reached your phone. The alert now stays up until a turn actually
  goes through on the account that stopped working, and if two accounts are down
  it waits for both (DOR-1682)
