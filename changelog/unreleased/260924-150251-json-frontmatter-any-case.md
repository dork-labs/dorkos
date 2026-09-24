---
covers:
  - 'fix(skills): read ---JSON frontmatter in any case (DOR-2317)'
---

### Fixed

- A skill or command file whose header starts with `---JSON` or `---Json` now reads the same as one starting with `---json`. Before, DorkOS said it couldn't read the file. (DOR-2317)
