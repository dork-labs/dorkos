---
covers:
  - 'fix(cli): say plainly when a Neon key cannot read the org, every time (DOR-2700)'
---

### Fixed

- Setting up a space server now works with a Neon organization key, the kind the setup guide asks for. Before, setup always stopped with "Neon preflight is unavailable", because Neon won't let that kind of key read its list of regions. Setup now checks your region against the list Neon's own command-line tool uses (DOR-2700).
- A Neon project key that can't see your organization now gets the same clear message every time, naming the key and the organization. Before, the message changed from run to run, and most runs gave the vague "preflight is unavailable" instead. A Fly token that Fly turns away is reported the same steady way (DOR-2700).
