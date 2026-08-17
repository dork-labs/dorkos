---
covers:
  - 'refactor(client): delete the Agent Hub feature, now that the Profile has replaced it'
  - 'refactor(client): one verb for the profile — View profile, everywhere'
  - 'fix(client): the Team table opens the profile the way the cards do, plus the push-in e2e (DOR-1255)'
  - 'fix(client): a same-session ?profile= link docks through the link opener, so a late layout cannot shut it (DOR-1254)'
  - 'fix(client): a profile link stops applying once you move to another agent (DOR-1254)'
  - 'fix(client): a link for an agent whose session you are not in still opens (DOR-1254)'
  - 'fix(client): a pending profile link is spent by the agent it named (DOR-1254)'
  - 'fix(client,server): one toast for a refused profile save, and one source for the file budgets (DOR-1253)'
  - 'fix(client): the docked panel asks before discarding, and each panel asks only about its own (DOR-1254)'
  - 'fix(client): a link that asks for the profile panel wins over a remembered layout (DOR-1254)'
  - 'fix(client,server): a profile only says "Saved" when the server stored it (DOR-1253)'
  - 'feat(client): the profile playground draws its pushed pages against a real manifest (DOR-1253)'
  - 'feat(client): the Profile docks in the right panel on a session (DOR-1254)'
  - 'fix(client,server): a profile edit changes what it names, and nothing else (DOR-1253)'
  - 'feat(client): profile pages and pickers for the agents you manage (DOR-1253)'
  - 'fix(client): profile header names the owner, and the deep-link docs stop calling it a drawer (DOR-1252)'
  - 'fix(client): a room reads the way its address is written, and a page needs a row (DOR-1252)'
  - "refactor(client): the hub's reusable guts move to the entities that own them (DOR-1253)"
  - "refactor(client): retire the drawer's name from the profile's neighbours (DOR-1252)"
  - 'refactor(server,shared): the people-only test calls the shared reader instead of copying it (DOR-1250)'
  - 'feat(client): the Rooms row and page, on the real roster data (DOR-1252)'
  - "feat(server,shared): a member's rooms carry the slug the cockpit prints (DOR-1250)"
  - 'fix(client): quiet the profile — the identity rule, a clear corner, no empty rows (DOR-1252)'
  - 'feat(client): one Profile — portrait header, property rows, push-in pages (DOR-1252)'
  - 'feat(server,client): rooms a team member is in, by member id (DOR-1250)'
  - "feat(server,shared): roster carries live activity and the local agent's folder (DOR-1249)"
---

### Changed

- Everywhere you could open an agent now says the same thing: **View profile**. The sidebar's "Agent hub", the Team table's "Manage", the status line's right-click menu, the command palette and the topology map all used a different word for the same act, and they all landed somewhere slightly different. One word now, and one place — the profile, which docks beside your session or slides in from the side depending on where you are (DOR-1255)
- Links you saved to the old Agent Hub still work. They open the profile (DOR-1255)
- On the Team page, **View profile** in the table now opens the same profile card the cards open, instead of a different panel off to the side (DOR-1255)
