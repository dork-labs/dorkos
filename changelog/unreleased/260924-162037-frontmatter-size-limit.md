---
covers:
  - 'fix(security): put a size limit on frontmatter DorkOS reads (DOR-2311)'
---

### Security

- A small skill or command file can no longer make DorkOS run out of memory or freeze when you look at a package. YAML lets a file repeat a value by name, and a few hundred bytes of those repeats can grow into billions of values. DorkOS now stops reading a file header that is too long, grows too large, or nests too deep, and reports the file as unreadable instead. Real skill and command headers are far below the limit. (DOR-2311)
