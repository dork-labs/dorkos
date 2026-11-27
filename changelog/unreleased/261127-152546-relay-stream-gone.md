---
covers:
  - 'feat(api): GET /api/relay/stream is gone; console traffic comes on /api/events (DOR-4986)'
  - 'feat(api): tunnel_status must name its audience, or it is dropped (DOR-4986)'
---

### Removed

- The address `GET /api/relay/stream` is gone. Messages to the app's own console address still come on `GET /api/events`, as `relay_message` and `relay_signal`. The old stream's other addresses, for system and signal traffic, were read by no screen and have no replacement.
