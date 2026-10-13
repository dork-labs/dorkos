---
covers:
  - 'perf(server): find a chat by id once, not on every read (DOR-2892)'
---

### Fixed

- Opening a chat no longer searches every Claude project folder on your computer each time. DorkOS remembers where each chat lives after the first look, and checks the folder you opened it from first. On a computer with many projects and several Claude accounts, this saves a noticeable pause on every chat you open (DOR-2892)
