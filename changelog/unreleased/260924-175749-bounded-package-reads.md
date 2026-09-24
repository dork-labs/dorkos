---
covers:
  - 'fix(security): bound how much DorkOS reads from packages and marketplaces (DOR-2319)'
---

### Security

- A marketplace or package can no longer make DorkOS load an enormous file or wait forever. DorkOS now stops reading a marketplace catalog past 5 MB, and any single file in a package past 1 MB, and says which one was too large. Reading a marketplace's extra DorkOS catalog file (`dorkos.json`) now gives up after the same wait as its main catalog. Real catalogs and package files are far smaller than these limits. (DOR-2319)
