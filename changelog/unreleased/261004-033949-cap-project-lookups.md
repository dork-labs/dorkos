---
covers:
  - 'fix(server): cap and person-gate project lookups, and limit background git calls (DOR-2547)'
---

### Fixed

- Only a person can ask DorkOS which project a folder belongs to (DOR-2547). An agent that asks is turned away, so it can't fill the project list with folders that hold their names forever.
- DorkOS now remembers at most 200 folders that were only looked up. Past that, it forgets the one used longest ago. Projects you work in, and ones an extension named, are never forgotten this way.
- Opening many folders at once no longer starts a burst of background `git` checks. DorkOS runs at most four at a time. A folder that isn't in a repository is checked less and less often, up to once every 10 minutes, instead of every minute.
