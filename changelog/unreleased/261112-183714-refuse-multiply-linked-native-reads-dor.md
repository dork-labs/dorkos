---
covers:
  - 'fix: refuse multiply linked native reads (DOR-4138)'
  - 'fix(server): check hard links on native writes only, so installed packages stay readable (DOR-4138)'
---

### Security

- OpenCode and Doe agents can no longer write to a file that has more than one hard link, so an edit can't reach a private file through an ordinary-looking second name. Reading such files still works, so installed packages stay readable.
