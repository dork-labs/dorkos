---
covers:
  - 'fix(server,mesh): agents found by the mesh take their #team seat right away (DOR-1042)'
---

### Fixed

- An agent that joins through the mesh — one you register by path, or one DorkOS
  finds while scanning your folders — now shows up in #team straight away instead
  of waiting for the next restart. It takes its seat quietly: #team still
  celebrates an agent you create, but a scan that picks up a folder full of
  agents you already had is DorkOS catching up on its own records, not news, so
  it says nothing (DOR-1042)
