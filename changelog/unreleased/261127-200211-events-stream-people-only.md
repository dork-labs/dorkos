---
covers:
  - 'feat(api): GET /api/events is a person’s stream, with rights asked as each frame goes out (DOR-4986)'
---

### Changed

- Agents can no longer open the app's live updates (`GET /api/events`, and the WebSocket at the same address). They use their own tools instead. A request with an agent's token is turned away with `403 person_only`. With login on, a program with only an API key is turned away too; with login off it can still connect.
- Who may see each update is checked as it is sent. If you leave a room, its updates stop from the next one on, even on a connection that was already open. Reconnecting with an id copied from someone else's stream sends you only what you may see.
