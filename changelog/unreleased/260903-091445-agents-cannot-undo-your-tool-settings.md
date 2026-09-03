---
covers:
  - 'fix(server,client,shared): every manifest field an agent can reach carries a written verdict (DOR-1506)'
  - 'fix(server): naming an object above a guarded leaf names every leaf under it (DOR-1506)'
---

### Fixed

- Turning an agent's tool groups off now sticks. An agent could quietly turn its own back on, undoing the change you made on its Tools page. The same goes for a handful of other settings about an agent that are yours to decide: its short name, the namespace that decides which agents it can reach, whether it speaks in a room without being asked, and which account pays for its work. Agents still edit everything about themselves that was always theirs — how they look, how they sound, their notes and their instructions (DOR-1506)
