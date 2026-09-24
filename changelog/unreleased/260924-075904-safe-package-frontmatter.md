---
covers:
  - 'fix(security): refuse executable frontmatter in package markdown (DOR-2308)'
---

### Security

- A package's files can no longer run code when DorkOS reads them. Before, a skill or command file whose header started with `---js` instead of `---` had that header run as code the moment DorkOS opened it, including when you only looked at a package before installing it. DorkOS now refuses to read those files. Headers written the normal way work exactly as before. (DOR-2308)
