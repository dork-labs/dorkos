---
covers:
  - 'fix(community): password guesses keep their own limit, so a flood of callers cannot reset it (DOR-2729)'
---

### Fixed

- A Community server now keeps its limit on wrong password guesses apart from its other limits. Before, someone could flood a public page with made-up addresses until the server forgot how many guesses an account had already used.
