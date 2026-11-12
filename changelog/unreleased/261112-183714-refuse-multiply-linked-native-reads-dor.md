---
covers:
  - 'fix: refuse multiply linked native reads (DOR-4138)'
---

### Security

- OpenCode and Doe agents can no longer read a file that has more than one hard link, so a private file can't be read under an ordinary-looking second name.
