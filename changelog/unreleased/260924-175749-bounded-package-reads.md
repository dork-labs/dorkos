---
covers:
  - 'fix(security): bound how much DorkOS reads from packages and marketplaces (DOR-2319)'
---

### Security

- A marketplace or package can no longer make DorkOS load an enormous file, wait forever, or read files outside the package. DorkOS now stops reading a marketplace catalog past 5 MB, and each file it reads to check a package past 1 MB, and says which one was too large. While checking a package, it no longer follows a shortcut (a symbolic link) inside the package, and it skips anything that isn't an ordinary file, so a package can't point DorkOS at your own files or leave it waiting on a device. Reading a marketplace's extra DorkOS catalog file (`dorkos.json`) now gives up after the same wait as its main catalog. Real catalogs and package files are far smaller than these limits. (DOR-2319)
