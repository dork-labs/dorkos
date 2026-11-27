---
covers:
  - 'feat(api): GET /api/tunnel/stream is gone; /api/events opens with the tunnel status (DOR-4986)'
---

### Removed

- The address `GET /api/tunnel/stream` is gone. Remote access changes now come only on `GET /api/events`, as `tunnel_status`. A new connection gets the current status first, so no second call is needed. Agents still never receive it.
