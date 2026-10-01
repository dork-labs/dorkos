---
covers:
  - 'fix(community): keep every file of a legally held community until the release'
  - 'fix(community): stop held unposted uploads counting toward storage'
---

### Fixed

- On a Community server, a legal hold now keeps every file the community has until the host releases it. Three cleanups could still delete some while a hold stood: uploads nobody posted, exports from older versions past their expiry, and files that were stored but never used. Now their files wait and are deleted once the hold is released. Nothing changes for the people in the community: an expired export still can't be downloaded, and an upload nobody posted still leaves after an hour and stops counting toward the storage limit. (DOR-2581)
