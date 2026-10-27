---
covers:
  - 'fix(server): repo trust cards ask what Allow does, and the badge says what a yes does (DOR-3359)'
---

### Changed

- When a repo's hooks or skills need your OK, the card now asks a plain question, like "Allow a changed skill in "my-app"?" or "Trust this repo's hooks and skills?". Its red label says what a yes does: "Runs code on this Mac" for hooks and settings, or "Widens what agents can run" for skills, subagents and commands.
