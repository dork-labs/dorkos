---
covers:
  - 'perf(client): the app opens with a smaller first download (DOR-2901)'
---

### Changed

- Every page of DorkOS starts with a smaller download. Settings and Scheduled tasks now load when you first open them instead of with the app, which trims about 7% off what each page downloads first. They are fetched quietly once the app is idle, so they usually still open at once.
