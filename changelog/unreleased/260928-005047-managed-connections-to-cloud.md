---
covers:
  - 'chore(site): forward managed connections to the DorkOS Cloud service behind their own switch (DOR-2485)'
---

### Changed

- Apps you connect through your DorkOS account can be served by the DorkOS Cloud service, which now holds your account. dorkos.ai hands those requests over the same way it already hands over signing in and your linked instances, once the service is ready for them (DOR-2485)
