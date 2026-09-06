---
covers:
  - 'fix(marketplace): source addresses are checked when you add them (DOR-1710)'
  - 'fix(marketplace): narrow source addresses to the forms that work, and log refusals (DOR-1710)'
---

### Fixed

- Adding a marketplace now checks the address before it saves it. A marketplace is either an `https://` link to a git repository or a `file://` folder on your own machine; anything else — including SSH-style `git@host:org/repo` addresses, which look right but can never load a listing — is turned down on the spot, with a note saying what to use instead. Previously any text at all was accepted and quietly failed later. Sources you already have are left exactly as they are (DOR-1710)
