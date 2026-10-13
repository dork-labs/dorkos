---
covers:
  - 'feat(site): count each desktop download, anonymously, at the link'
  - 'fix(site): skip HEAD probes, limit counts per address, and say exactly what a download count carries'
---

### Added

- The website now counts desktop app downloads, including ones from links on other sites. Each count carries a random one-time ID, no cookie and not your IP address, and none is made when your browser asks not to be tracked. The privacy page says so.
