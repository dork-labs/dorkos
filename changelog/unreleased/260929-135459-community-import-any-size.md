---
covers:
  - 'feat(community): import version 1 and 2 exports of any size, uploaded in parts (DOR-2296)'
  - 'fix(community): harden version 2 import after review (DOR-2296)'
  - 'fix(community): let agent logs import, and tear a failed import down fast (DOR-2296)'
  - 'fix(community): refuse every export scope but owner by name, evidence included (DOR-2296)'
---

### Added

- A Community host can now import a community of any size, whether its export was made before or after exports became background jobs. Through the host API, a large export can go up in numbered pieces, so a dropped connection costs one piece, not the whole file, and the upload picks up where it stopped. The server checks the whole file before it restores anything, then brings the community back a piece at a time, so a restart carries on instead of starting over. Newer exports also bring back more than older ones did: the community's picture and description, removed and erased messages marked as removed, and the channels the owner was actually in. A host can set the largest import it takes and how long an upload may take. (DOR-2296)
