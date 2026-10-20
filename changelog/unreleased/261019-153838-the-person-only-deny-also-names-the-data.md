---
covers:
  - "fix(server): the person-only deny also names the data folder's real path (DOR-2969 part 3)"
---

### Security

- The guard that stops agents from editing your permission settings now holds when your DorkOS data folder is reached through a shortcut (a symlink) or set with a relative path. (DOR-2969)
