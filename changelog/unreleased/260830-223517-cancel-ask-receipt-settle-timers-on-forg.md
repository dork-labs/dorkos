---
covers:
  - 'fix(client): cancel ask-receipt settle timers on forget/clear (DOR-1633)'
---

### Fixed

- Fixed a rare bug where answering a request again after the server refused your first answer (for example, another window already answered it) could make its confirmation card disappear too soon (DOR-1633)
