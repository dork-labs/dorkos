---
covers:
  - 'fix(security): limit how large a package DorkOS installs (DOR-2321)'
---

### Security

- A package can no longer fill your disk. DorkOS now refuses a package larger than 250 MB in total, with more than 20,000 files, or with any single file over 50 MB, and says which limit it hit. It checks this before showing what a package will do, again before copying it into place, and right after downloading one from git, before anything reads it. The files DorkOS reads from packages you already have installed are now held to the same 1 MB per-file limit as the ones it checks before installing. Real packages are far below these limits. (DOR-2321)
