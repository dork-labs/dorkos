---
covers:
  - 'fix(community): a deleted space is never stuck waiting on an unfinished upload (DOR-2872)'
---

### Fixed

- Deleting a space now always finishes. Before, one upload that never finished could keep a space stuck "deleting" for good. Now the server waits at most a day for such an upload, then removes the space.
- A space server's log now says when a space is more than two days past its deletion date and still not gone.
