---
covers:
  - 'feat(cloud-api): name the space servers where the DorkOS account signs a person in (DOR-2634)'
  - 'feat(spaces): start and join a space on DorkOS with your DorkOS account (DOR-2634)'
  - 'test(server): name the dropped field plainly (DOR-2634)'
---

### Added

- Starting or joining a space that runs on DorkOS no longer asks you to make a second account there. Where the space's site signs people in with your DorkOS account, the pages DorkOS opens for you (making the space yours, an invitation, approving this DorkOS) lead with **Continue with** your DorkOS account, and every other way to sign in stays one step away. A space you run on your own server keeps its own accounts. (DOR-2634)
