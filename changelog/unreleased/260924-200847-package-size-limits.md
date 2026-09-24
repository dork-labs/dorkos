---
covers:
  - 'fix(security): limit how large a package DorkOS installs (DOR-2321)'
  - 'fix(security): bound a git download while it runs, and its tree before checkout (DOR-2321)'
  - 'fix(security): size a blobless download before checkout, and stop git's whole process tree (DOR-2321)'
  - 'fix(security): give a git download one deadline and stop running git on exit (DOR-2321)'
  - 'fix(shared): read file-open flags lazily, so a partial node:fs mock can import bounded-read (DOR-2321)'
---

### Security

- A package can no longer fill your disk. DorkOS now refuses a package larger than 250 MB in total, with more than 20,000 files and folders, or with any single file over 50 MB, and says which limit it hit. It checks this before showing what a package will do, and again before copying it into place. A download from git is stopped as soon as it grows past 1 GB or takes longer than 10 minutes, and a download that would unpack into more than 100,000 files and folders, or more than 1 GB, is refused before a single file is written. If you install from a folder on your computer, DorkOS copies its `node_modules` too, and the message says how much of the package is in there. The files DorkOS reads from packages you already have installed are now held to the same 1 MB per-file limit as the ones it checks before installing. Real packages are far below these limits. (DOR-2321)
