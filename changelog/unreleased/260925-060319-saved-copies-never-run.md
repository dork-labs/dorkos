---
covers:
  - 'fix(security): copies saved aside by an update never run or load (DOR-2340)'
---

### Security

- A copy DorkOS saves aside when it updates or removes a package can no longer run. Saved copies used to keep their permission to run as a program, and a saved program in a package's `bin/` folder stayed on your agents' command path. A saved skill or command folder still loaded in your sessions. Now every saved copy loses its permission to run, and a whole folder set aside goes in the package's `.dork/saved/` folder, where nothing loads it. DorkOS fixes copies saved by earlier versions the next time it starts. A package's list of programs now counts only files that can actually run. (DOR-2340)
