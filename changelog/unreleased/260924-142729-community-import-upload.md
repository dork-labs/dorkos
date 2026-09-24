---
covers:
  - 'feat(community): start an import and upload an owner export to a new community (DOR-2258)'
  - 'fix(community): bound export uploads by lease, slots, space, and idle time (DOR-2258)'
  - 'fix(community): count in-flight uploads against free space and time-limit JSON bodies (DOR-2258)'
---

### Added

- A Community host can start moving a community in from another host. Starting an import makes a new, empty community that nobody owns yet, and gives back a one-time upload link for the owner's export file. The link keeps working if an upload breaks off or sends the wrong file, until it expires after a day. A large upload can take as long as it needs, as long as it keeps sending. The host can cancel an import at any time before it finishes, which removes the new community and the uploaded file. Nobody can claim the community while it is being imported. (DOR-2258)
