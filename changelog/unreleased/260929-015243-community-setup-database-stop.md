---
covers:
  - 'fix(cli): read the database, address and version replies Neon and Fly really send in community deploy (DOR-2536)'
  - 'fix(cli): accept a Neon region with an unknown location in community deploy (DOR-2536 review)'
---

### Fixed

- Setting up your own community with `dorkos community deploy` no longer stops right after it creates the database. Neon labels each database with a number, setup expected text, and so it gave up and asked you to check by hand. Setup also stops failing later on, when it reads your app's public address, and it now recognises the Fly command-line tool on Linux, where the tool reports its name as `flyctl`. And a Neon region with no known location no longer stops setup before it starts (DOR-2536)
