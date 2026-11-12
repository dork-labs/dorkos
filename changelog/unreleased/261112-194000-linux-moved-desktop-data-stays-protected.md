---
covers:
  - 'fix(server): desktop data stays protected when Linux XDG_CONFIG_HOME moves it (DOR-4139)'
---

### Security

- On Linux, when `XDG_CONFIG_HOME` moves the desktop app's data out of your home folder, agents still can't read it, and below Full they can't change it either.
