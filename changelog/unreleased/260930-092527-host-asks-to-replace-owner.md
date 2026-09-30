---
covers:
  - 'feat(community): let a host ask to replace an owner who has left (DOR-2539)'
---

### Added

- A Community host can now ask to make someone else the owner of a community whose owner has left and can't be reached. The owner is told by email first and gets a waiting period to say no. If they say no, the host can't ask again for 90 days. The host can also list its requests, cancel one, or send the new owner a fresh link, and the owner is told when it does. Asking needs the new `communities:ownership` key permission, or an operator's password, and it only works once the host has set up mail (DOR-2539)
