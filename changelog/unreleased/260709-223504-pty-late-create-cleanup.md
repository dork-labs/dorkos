### Fixed

- Closing a terminal tab the instant it was created no longer leaks a hidden shell process: a terminal that finishes starting after its tab is gone is now cleaned up (or kept for re-attach when grace applies). (DOR-226, #176)
