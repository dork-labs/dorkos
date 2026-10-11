---
covers:
  - 'perf(community): live streams read each new message once and share it (DOR-2764)'
  - 'perf(community): a post reads only the part of the roster it could mention (DOR-2830)'
  - 'perf(community): streams keep a minute of entries and spread their access rechecks (DOR-2830)'
---

### Changed

- A Community server now reads each new message once and hands the same copy to everyone who has that channel open, instead of reading it again for each person. New messages reach a busy channel far faster, and someone who loses access still stops getting messages at once (DOR-2830)
- Posting in a large Community channel is quicker: the server looks up only the people a message mentions, not everyone in the channel (DOR-2830)
