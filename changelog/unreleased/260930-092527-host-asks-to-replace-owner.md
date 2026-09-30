---
covers:
  - 'feat(community): let a host ask to replace an owner who has left (DOR-2539)'
  - 'fix(community): refuse owner replacements until their notices can be sent (DOR-2539 review)'
  - 'feat(community): email the owner and run the owner-replacement waiting period (DOR-2540)'
  - 'fix(community): keep owner replacements refused until the owner can answer (DOR-2540 review)'
  - "fix(community): never count an owner's waiting period shorter than their notice promised (DOR-2540 review)"
  - 'fix(community): repeat the promised date when a claim link is sent again before the notice resolves (DOR-2540 review)'
  - 'fix(community): name one date in every owner-replacement email (DOR-2540 review)'
---

### Added

- Community hosts get the first part of a way to replace an owner who has left: new host routes to ask for a replacement, list the requests, cancel one, or send the new owner a fresh link. They need the new `communities:ownership` key permission, or an operator's password. For now every request is refused, because the owner can't yet answer the email that tells them. Asking will open up in a later release, once the owner's "Keep ownership" link and the new owner's claim are ready (DOR-2539, DOR-2540)
