---
covers:
  - 'fix(marketplace): source addresses are checked when you add them (DOR-1710)'
---

### Fixed

- Adding a marketplace now checks the address before it saves it. If what you typed isn't something DorkOS can fetch a marketplace from, you get told so — and told which forms do work — instead of ending up with a source that quietly fails later. The same check now also runs the moment an address is about to be used to fetch a package (DOR-1710)
