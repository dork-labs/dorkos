---
covers:
  - "fix(ask): a third-party tool's title names its server (DOR-4117)"
  - "fix(ask): the approval card's shield keeps its size beside a long title (DOR-4247)"
---

### Fixed

- When an agent asks to use a tool from a server you added, the card's title now names that server, like "Atlas wants to use Bash from evil". A tool from an added server can no longer pass for a built-in one with the same name. (DOR-4117)
