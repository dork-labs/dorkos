---
covers:
  - 'fix(rooms): ask who the operator is, not whether the author is human (DOR-598)'
---

### Security

- Channels and direct messages now work out who may see and change things by asking "is this the person who owns this computer?" rather than "is this a person?". Nothing you can see changes — your DorkOS is yours alone and stays that way — but the old question stops being the right one the moment your machine starts holding messages written by other people, and this is the groundwork for that. (DOR-598)
