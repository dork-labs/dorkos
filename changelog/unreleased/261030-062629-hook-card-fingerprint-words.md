---
covers:
  - 'fix(server): the hook card says "fingerprint" and names file states in words (DOR-3340)'
---

### Fixed

- The card that asks before a package runs commands now shows each file's "fingerprint" instead of "sha256". A file that isn't there yet, a folder, a file it can't read, or a very large file is now said in plain words. A very large file is also tracked more closely, so changing it while keeping its timestamp still asks you again.
