---
covers:
  - 'fix(server): cap and person-gate project lookups, and limit background git calls (DOR-2547)'
  - 'fix(server): close the second lookup door and harden the lookup cap (DOR-2547 review)'
  - 'fix(server): never show a taken name for an unknown root; read git in the C locale (DOR-2547 review)'
---

### Fixed

- Only a person can ask DorkOS which project a folder belongs to (DOR-2547). An agent or another website that asks is turned away, so it can't fill the project list with folders that hold their names forever. Checking which accounts may work in a folder no longer records the folder at all.
- DorkOS now remembers at most 200 folders that were only looked up. Past that, it forgets the one used longest ago. Projects you work in, ones an extension named, and ones your account settings name are never forgotten this way.
- Opening many folders at once no longer starts a burst of background `git` checks. DorkOS runs at most four at a time. A folder that isn't in a repository is checked less and less often, up to once every 10 minutes, instead of every minute. If a check fails for another reason, such as a timeout, it is tried again after a minute.
