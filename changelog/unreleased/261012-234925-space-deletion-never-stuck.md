---
covers:
  - 'fix(community): a deleted space is never stuck waiting on an unfinished upload (DOR-2872)'
  - 'fix(community): review fixes for the stuck-deletion fix (DOR-2872)'
  - 'chore: fold the review fixes into the stuck-deletion changelog fragment (DOR-2872)'
---

### Fixed

- One unfinished upload no longer keeps a deleted space stuck "deleting" for good. The server now waits at most a day for such an upload, then finishes removing the space.
- A space server's log now says when a space is more than two days past its deletion date and still not gone.
