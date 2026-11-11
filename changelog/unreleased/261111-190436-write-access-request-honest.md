---
covers:
  - 'fix(connections): an agent that asks to change things in an app hears plainly when it can only read (DOR-4193)'
  - 'fix(connections): request_connection tells agents a granted answer can leave write out (DOR-4193)'
  - 'feat(connections): apps with no Read and write level say so on the Connections page, the access picker and the request card (DOR-4193)'
---

### Fixed

- When an agent asks to read and change things in an app, it no longer hears "You can now read" as if that were everything. Its answer now says what it didn't get, and why. Maybe you picked Read. Or maybe Read and write isn't offered for that app yet, as with Linear today. (DOR-4193)
- Asking again for more access now always puts a card in front of you. Before, an agent that already had Read could be told it was done without you seeing anything. (DOR-4193)
- Apps with no Read and write level now say so before you choose. The Connections page says "Read and write isn’t offered for Linear yet." The access picker shows Read and write greyed out, with that same line under it. When an agent asks to change things there, the card's button says **Allow read only**. (DOR-3616, DOR-3021)
- On a phone, the "Connect another account" link under a request card now wraps instead of running off the edge. (DOR-4211)
