---
covers:
  - 'feat(community): take owner replacement requests on hosts with mail (DOR-2252)'
  - 'fix(community): check main.ts wiring and drop stale "refused for now" notes (DOR-2252)'
---

### Added

- If you run your own Community server, you can now ask for a new owner for a space whose owner has left. The owner gets an email and a note on the space's own site, and can keep ownership with one click. If their DorkOS is connected to the space, DorkOS tells them too the next time they open it. If they don't answer in time, the new owner can take over: with single sign-on, only the account you named; without it, whoever you send the claim link to. You need two things: mail set up on your server, and a host key with the ownership permission (or your own password). Without mail, the request is refused, because the owner could not be told (DOR-2252)
