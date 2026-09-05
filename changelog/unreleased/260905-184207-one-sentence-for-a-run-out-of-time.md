---
covers:
  - 'fix(relay,server): one plain sentence for a run that hit its time limit (DOR-1786)'
---

### Fixed

- A scheduled run that hits its time limit now says so the same way everywhere, in plain words. Depending on how the run was started, its record used to read either "Run stopped after passing its 5m time limit" or "Run timed out (TTL budget expired)" — the same thing, said twice, once in jargon (DOR-1786)
