---
covers:
  - 'feat(community): take owner replacement requests on hosts with mail (DOR-2252)'
---

### Added

- If you run your own Community server, you can now ask for a new owner for a space whose owner has left. The owner gets an email, a note in the space, and a notice in DorkOS, and can keep ownership with one click. If they don't answer in time, the person you named can take over. You need two things: mail set up on your server, and a host key with the ownership permission (or your own password). Without mail, the request is refused, because the owner could not be told (DOR-2252)
