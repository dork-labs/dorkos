---
covers:
  - "fix(server): person-only actions need the person's session at this computer (DOR-3330)"
  - "fix(server): bind the person session to the app's own page; ask before the first chat (DOR-3330)"
  - "fix(server): the proof at sign-in's own endpoints and the desktop window (DOR-3330)"
  - 'fix(server): person bars on tasks, chat mode, sources and the local token; final step-up copy (DOR-3330)'
  - 'fix(server): wrong owner passwords slow the next try instead of locking it (DOR-3330)'
  - "fix(server): parallel wrong owner passwords can't skip the wait (DOR-3330)"
  - 'fix(server): drop the person-only bar on the mesh access route (DOR-3330)'
  - 'test(server): Wi-Fi room posts come from a signed-in person (DOR-3330)'
  - 'test(server): the Claude sign-in routes ask the app for the step-up at this computer (DOR-3330)'
---

### Security

- Some things only you can do in DorkOS, like approving what an agent asked for, now ask for your password once on the computer DorkOS runs on. After that, this browser stays confirmed there and doesn’t ask again. Looking around never asks (DOR-3330)
