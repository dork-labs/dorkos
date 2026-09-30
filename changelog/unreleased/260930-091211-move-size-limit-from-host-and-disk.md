---
covers:
  - 'fix(cloud): size a community move by the new host and the free disk, not a fixed 16 GiB (DOR-2587)'
---

### Changed

- Moving a community into a hosted community no longer stops at a fixed 16 GB. How large a move can be now depends on two things: what the new host says it will take, and how much free space this computer has to hold the file while it goes up. If the file won't fit on this computer, the move stops before anything is copied and says how much space it needs and how much is free. If the file is larger than the new host takes, the move stops before anything is sent, is cancelled, and says both sizes. (DOR-2587)
