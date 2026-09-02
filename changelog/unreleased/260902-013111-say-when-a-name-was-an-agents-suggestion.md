---
covers:
  - "feat(server,client,shared): say when a display name was an agent's suggestion (DOR-1022)"
  - 'fix(server,client): close two ways the name-provenance note could be defeated (DOR-1022)'
---

### Added

- When DorkBot picks the name DorkOS calls you — usually because you told it
  "call me Dorian" in a chat — your team page, your account menu and Settings ›
  Profile now say "Suggested by DorkBot" under that name. Save a name yourself
  in Settings › Profile and the note goes away for good, even if you save the
  same name it picked (DOR-1022)

### Note for people upgrading

- Names already on your machine keep working exactly as they do today and get no
  note. DorkOS only started recording who picks a name in this release, so it
  will not guess about one it did not see written (DOR-1022)
