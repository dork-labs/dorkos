---
covers:
  - 'fix(cli): read a storage bucket Fly has just deleted as gone (DOR-2169)'
---

### Fixed

- Removing a self-hosted community's file storage is now recognised as done straight away. For a while after it's removed, Fly still lists the storage under a new name, marked deleted and no longer attached to your app, and setup used to treat that as an error it couldn't read (DOR-2169)
