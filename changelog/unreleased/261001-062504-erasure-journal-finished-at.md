---
covers:
  - 'feat(community): say when each erasure journal line finished'
---

### Added

- On a Community server, each line of the erasure journal a host copies now says when that erasure finished, as `finishedAt`. A copy kept somewhere else can now delete old lines on the same schedule as the server, instead of counting from when it copied them. The lines in the app log and the `COMMUNITY_ERASURE_JOURNAL` file stay as they were, and `erasure:reapply` reads both kinds. (DOR-2621)
