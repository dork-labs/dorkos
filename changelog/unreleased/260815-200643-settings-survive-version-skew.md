---
covers:
  - 'fix(server): settings survive a build that writes a setting this one has never heard of (DOR-1221)'
---

### Fixed

- Your settings no longer get wiped when you run more than one version of DorkOS. A setting saved by a newer version used to make the whole file look damaged to an older one, which backed it up and started again from the defaults. Now it is left alone, kept in the file, and skipped (DOR-1221)
- If your settings ever do have to be rebuilt, the copy DorkOS saves keeps the date and time in its name, and the last ten are kept. Before, every rescue wrote over the one before it, so the copy you actually wanted was already gone (DOR-1221)
- When DorkOS fails while updating your settings file to a new version, it now stops and tells you, and it does not replace or delete your settings. It used to treat its own bug as a damaged file and start you over from the defaults (DOR-1221)
