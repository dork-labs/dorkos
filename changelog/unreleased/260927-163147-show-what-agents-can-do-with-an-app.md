---
covers:
  - 'feat(connections): show what agents can do with an app, tied to the access choice (DOR-2465)'
  - 'fix(connections): tie app actions to what a level grants on the account (DOR-2465)'
  - "fix(connections): never bring back a dropped way's action list (DOR-2465)"
  - 'fix(connections): answer from the current way when it is replaced mid-read (DOR-2465)'
---

### Added

- An app's side panel now shows what agents can do with it, right under "Who can use it". Pick "Read" and you see what agents can look at; pick "Read and write", where an app offers it, and you also see what they can change. Actions that neither choice includes, like sending or deleting email in many apps, are named too, with how to allow them one at a time. "See all" lists every action, each marked Look or Change. The same list shows before you connect an app, to help you decide (DOR-2465)
- Apps whose service can't list their actions say so plainly, and everything agents do in them counts as a change. The list is kept for a day, so reopening a panel is instant (DOR-2465)
