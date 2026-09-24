---
covers:
  - 'fix(security): refuse executable frontmatter in package markdown (DOR-2308)'
  - 'fix(security): tighten the frontmatter wrapper after review (DOR-2308)'
  - 'fix(security): read plugin skill frontmatter through the safe reader (DOR-2308)'
---

### Security

- A package's files can no longer run code when DorkOS reads them. Before, a skill or command file whose header started with `---js` instead of `---` had that header run as code the moment DorkOS opened it, including when you only looked at a package before installing it. DorkOS now refuses to read those files. Headers written the normal way read the same as before, with one small correction: a number written with a leading zero, like `0123`, now reads as 123. Before, it could come out as a different number (83). (DOR-2308)
