---
covers:
  - 'fix(server): a broad capability search stays compact instead of dumping every schema (DOR-988)'
  - 'fix(server): the mock OAuth server refuses tokens it never issued (DOR-988)'
  - 'fix(server): the config migration guard compares migration bodies, not just keys (DOR-988)'
  - 'fix(server): a capability search that matches nothing says so (DOR-988)'
---

### Fixed

- **Searching for a capability no longer eats your agent's memory.** Asking DorkOS "what can I do
  here?" with a search word attached used to hand back the full manual for every match, which on a
  broad word like "server" was more text than asking for everything. Now a search only expands to
  full detail when it narrows things down to a handful, and every answer that leaves something out
  says so and how to get the rest. A search that finds nothing now says that plainly and suggests
  broadening, instead of describing results it does not have. Agents are told the new rules too, so
  they stop expecting one giant list (DOR-988)
- **`dorkos call` stops claiming a real capability does not exist.** When the catalog was too big
  for the command to read in one go, it quietly stopped early and then reported perfectly valid
  ids as unknown. It now says plainly that the app and the command are out of step (DOR-988)
- **Two of our own safety checks were passing without checking anything.** The stand-in sign-in
  server used in testing accepted any token at all, and the check that stops a settings upgrade
  from silently doing nothing only looked at names, not at what the upgrade actually does. Both
  now fail when they should, so a broken upgrade path gets caught before it reaches you (DOR-988)
