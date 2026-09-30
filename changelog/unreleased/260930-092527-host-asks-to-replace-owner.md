---
covers:
  - 'feat(community): let a host ask to replace an owner who has left (DOR-2539)'
  - 'fix(community): refuse owner replacements until their notices can be sent (DOR-2539 review)'
  - 'feat(community): email the owner and run the owner-replacement waiting period (DOR-2540)'
---

### Added

- Community hosts can start replacing an owner who has left. The owner is emailed first and gets at least 7 days, or 30 when the email couldn't be delivered or their address was never confirmed, with a reminder 2 days before the end. Hosts can list their requests, cancel one, or send the new owner a fresh link, and the owner is emailed each time. It needs the new `communities:ownership` key permission, or an operator's password, and mail set up. Taking ownership, and the owner's "Keep ownership" link, arrive in a later release; until then a request ends on its own after the waiting period and 14 more days (DOR-2539, DOR-2540)
