---
covers:
  - 'fix(cli): say plainly when a Neon key cannot read the org, every time (DOR-2700)'
---

### Fixed

- Setting up a space server with a Neon key that can't see your organization now says so every time, naming the key and the organization. Before, the same key got that clear message only some of the time, and otherwise a vague "Neon preflight is unavailable" that sent you to check the wrong thing. Fly sign-in problems get the same steady message (DOR-2700).
