---
covers:
  - 'fix(server,mesh): agents found by the mesh take their #team seat right away (DOR-1042)'
---

### Fixed

- An agent that joins through the mesh — one you register by path, or one DorkOS
  finds while scanning your folders — now shows up in #team straight away instead
  of waiting for the next restart. Re-scans stay quiet: an agent DorkOS already
  knows is not announced again, so nothing gets a second welcome (DOR-1042)
