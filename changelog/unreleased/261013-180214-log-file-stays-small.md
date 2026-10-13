---
covers:
  - 'perf(server): keep the log file open and rotate it while DorkOS runs (DOR-2902)'
---

### Fixed

- DorkOS's log files stay a sensible size while it runs. A log file used to be split by size and day only when DorkOS started, so a server that stayed up wrote one file without limit; one reached 53 MB. DorkOS now keeps the last 14 days of logs, up to 200 MB in all, and each log line is about eight times cheaper to write (DOR-2902)
