---
covers:
  - 'fix(community): keep connections, agents, and invitations through a host hold'
  - 'fix(community): let a kept grant list its agents while held, and document removals and read positions'
---

### Changed

- A host hold on a Community no longer disconnects anyone. Connected DorkOS installations and agents keep reading while the community is on hold, invitations and half-finished sign-ups wait, and when the host releases the hold, posting and live updates come back without anyone connecting again. To cut people off, a host suspends the community instead (DOR-2286).
- Opening an invitation to a held community now says "This community is on hold. You can join when the hold ends." The same link works after the hold if it has not expired (DOR-2286).
