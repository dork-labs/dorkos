---
covers:
  - 'feat(community): let a host ask to replace an owner who has left (DOR-2539)'
  - 'fix(community): refuse owner replacements until their notices can be sent (DOR-2539 review)'
---

### Added

- Community hosts get the first part of a way to replace an owner who has left: new host routes to ask for a replacement, list the requests, cancel one, or send the new owner a fresh link. They need the new `communities:ownership` key permission, or an operator's password. For now every request is refused, because the server can't yet email the owner about it. Asking will open up in a later release, once the owner's notice and their way to say no are ready (DOR-2539)
