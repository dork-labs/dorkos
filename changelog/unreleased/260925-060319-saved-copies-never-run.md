---
covers:
  - 'fix(security): copies saved aside by an update never run or load (DOR-2340)'
  - "fix(security): the saved-copies boot pass moves only a package's own copies and keeps approvals (DOR-2340)"
  - 'test(marketplace): the recorded DOR-2340 reproduction as a regression test'
  - 'fix(marketplace): keep the saved-copies mark in the record, so an uninstall leaves nothing (DOR-2340)'
---

### Security

- A copy DorkOS saves aside when it updates or removes a package can no longer run. Saved copies used to keep their permission to run as a program, and a saved program in a package's `bin/` folder stayed on your agents' command path. A saved skill or command folder still loaded in your sessions. Now every saved copy loses its permission to run, and a whole folder or a program set aside goes in the package's `.dork/saved/` folder, where nothing runs or loads it. DorkOS fixes copies earlier versions saved from a package's own files the next time it starts, leaves your own folders where they are, and keeps a package you approved approved. A package's list of programs now counts only files that can actually run. (DOR-2340)
