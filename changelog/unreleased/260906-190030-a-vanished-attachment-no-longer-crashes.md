---
covers:
  - 'fix(server): a vanished attachment file no longer crashes the server (DOR-1831)'
  - 'fix(server): the vanished-attachment seam cannot go vacuous, and the avatar test uses the shared discard (DOR-1831)'
---

### Fixed

- Opening a file or a picture from a room or a transcript at the exact moment it was deleted could take the whole app down, instead of just failing that one request. Now only that one request fails, and everything else you have open keeps running.
