---
covers:
  - 'fix(connections): a relink keeps Read for changes the write update set aside before 0.137.0 (DOR-4735)'
  - 'fix(connections): match set-aside changes whatever reason 0.136.0 left on them (DOR-4735)'
---

### Fixed

- If you updated to 0.136.0 before this fix, linking your DorkOS account again no longer lets agents make changes in an app the Read and write update set back to Read. Your agents stay on Read until you choose Read and write.
