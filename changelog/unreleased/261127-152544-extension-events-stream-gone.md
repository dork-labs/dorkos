---
covers:
  - 'feat(api): GET /api/extensions/events is gone; extension reloads come on /api/events (DOR-4986)'
---

### Removed

- The address `GET /api/extensions/events` is gone. The news that an extension reloaded now comes only on `GET /api/events`, as `extension_reloaded`, which the app already read.
