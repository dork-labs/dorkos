---
covers:
  - 'fix(workbench): preserve preview script policies'
---

### Security

- Preview pages keep every script restriction sent by their web server.
- DorkOS adds its preview scripts only when the page format and script rules safely allow them.
