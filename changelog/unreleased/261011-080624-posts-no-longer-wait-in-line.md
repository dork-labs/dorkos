---
covers:
  - 'perf(community): posts no longer queue on the channel lock (DOR-2837)'
  - 'feat(community): split a load run across several load machines (DOR-2837)'
---

### Changed

- People can post in a busy Community channel at the same time without waiting in line behind each other. Each message still gets its place in the channel in order, so nobody misses one or sees them out of order. In a test on one laptop with 10,000 people watching one channel, messages arrived about three times faster (DOR-2837)

### Added

- Community hosts can split a load test across several computers, all posting into the same test space at the same moment, when one computer cannot open enough connections by itself (DOR-2837)
