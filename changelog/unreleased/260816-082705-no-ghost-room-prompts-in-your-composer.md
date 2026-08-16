---
covers:
  - "fix(server,evals): a room's trigger never lingers in your composer (DOR-1242)"
  - 'fix(server): act on a dropped room trigger, sweep the rows older builds left (DOR-1242)'
---

### Fixed

- A message a channel sends to one of your agents no longer turns up in that agent's chat box, waiting to be sent, as though you had typed it. Any left over from an earlier version are cleared out the next time that chat opens (DOR-1242)
- Restarting DorkOS no longer fires an old channel message into a conversation that ended days ago (DOR-1242)
- When a channel truly cannot get an answer, it says so right away instead of promising a reply that never arrives and then giving up an hour later (DOR-1242)
