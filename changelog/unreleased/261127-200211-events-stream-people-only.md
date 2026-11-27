---
covers:
  - 'feat(api): GET /api/events is a person’s stream, with rights asked as each frame goes out (DOR-4986)'
  - 'feat(api): the person bar accepts a page at a DORKOS_TRUSTED_HOSTS name, read only from the server’s own environment (DOR-4986)'
  - 'fix(cli): the project .env file can’t change how DorkOS runs (DOR-4986)'
---

### Changed

- Agents can no longer open the app's live updates (`GET /api/events`, and the WebSocket at the same address). They use their own tools instead. A request with an agent's token is turned away with `403 person_only`. With login on, a program with only an API key is turned away too; with login off it can still connect.
- Who may see each update is checked as it is sent. If you leave a room, its updates stop from the next one on, even on a connection that was already open. Reconnecting with an id copied from someone else's stream sends you only what you may see.
- Behind your own proxy, a page served at a name in `DORKOS_TRUSTED_HOSTS` now counts as DorkOS's own for the live updates and for the settings only a person may change. It must use `https`, or plain `http` at 127.0.0.1, ::1 or a private network address (10.x, 172.16 to 172.31, 192.168.x, or an IPv6 address starting fc or fd), not a Tailscale or link-local one. The project `.env` file can't change how DorkOS runs.
