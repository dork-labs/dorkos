---
covers:
  - 'fix(site): docs search finds the page that explains the thing (DOR-701)'
---

### Fixed

- Search on the docs site now puts the page that explains a topic first. Searching "relay" used to return a long reference page that merely mentions relay, with the Relay page itself down at eleventh (DOR-701)
- Docs search now understands word endings and small typos: "scheduling" finds what "schedule" finds, and "releay" still finds Relay (DOR-701)
- Asking docs search a full question no longer costs a giant download. A five-word question used to return around 300 KB — worse than reading the whole documentation index — and now costs about the same as a one-word search (DOR-701)
