---
covers:
  - 'feat(cloud-api): name the space servers where the DorkOS account signs a person in (DOR-2634)'
  - 'feat(spaces): start and join a space on DorkOS with your DorkOS account (DOR-2634)'
  - 'test(server): name the dropped field plainly (DOR-2634)'
  - 'fix(spaces): keep the not-joined sign-in buttons and refresh space sign-in on relink (DOR-2634)'
---

### Added

- Where a space's site signs people in with your DorkOS account, starting or joining it no longer asks for a second account. The pages DorkOS opens for you there (making the space yours, an invitation, approving this DorkOS) lead with **Continue with** your DorkOS account, and every other way to sign in stays one step away. Everywhere else, including a space you run on your own server, nothing changes. (DOR-2634)
