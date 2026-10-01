---
covers:
  - 'fix(community): keep every file of a legally held community until the release'
---

### Fixed

- On a Community server, a legal hold now keeps every file the community has until the host releases it. Three cleanups still deleted some while a hold stood: uploads nobody posted, exports past their expiry, and files whose upload failed. Now they wait, and run once the hold is released. Nothing changes for the people in the community: an expired export still can't be downloaded, and an old unposted upload still can't be posted. (DOR-2581)
