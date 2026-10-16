---
covers:
  - 'feat(cloud-api): hubs, cloud agent computers, the viewer-open wake and the account directory (DOR-2933)'
  - "fix(cloud-api): fold in DorkOS Cloud's and the review's changes to the hub and directory shapes (DOR-2933)"
---

### Added

- `@dork-labs/cloud-api` describes how your own DorkOS in the cloud learns who it belongs to: by your account id, never your email, and it belongs to nobody until it is yours (DOR-2933)
- `@dork-labs/cloud-api` describes how your DorkOS in the cloud asks DorkOS Cloud to start, stop or delete your cloud agent computers, so it never holds the keys to them itself (DOR-2933)
- `@dork-labs/cloud-api` describes how your account remembers your computers, your agents, your quiet hours and the spaces you belong to. It keeps where each one is, never a way to sign in to it (DOR-2933)
- `@dork-labs/cloud-api` describes a new command that asks one of your computers to connect to your DorkOS in the cloud. Computers on this release read it and do nothing with it yet. The same goes for a second new command, which tells your DorkOS in the cloud to check who it belongs to (DOR-2933)
