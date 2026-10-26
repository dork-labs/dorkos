---
covers:
  - 'fix(server): person-only actions need the person’s session at this computer (DOR-3330)'
---

### Security

- Some things only you can do in DorkOS, like approving what an agent asked for, now ask for your password once on the computer DorkOS runs on. After that, this browser stays confirmed there and doesn’t ask again. Looking around never asks (DOR-3330)
