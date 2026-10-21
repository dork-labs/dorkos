---
covers:
  - 'fix(server): a held turn asks before running what the folder allows (DOR-3204)'
  - 'fix(server): a held turn still reads its own folder unasked, and only its own (DOR-3204)'
---

### Fixed

- A turn started by someone DorkOS can't vouch for, like a message from a stranger or a Wi-Fi sign-in, now asks before running commands the project's settings allow. The project's blocked commands stay blocked, and these approval cards don't offer Always allow. (DOR-3204)
