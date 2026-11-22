---
covers:
  - 'fix(server): a mini app waiting for your OK no longer turns off "Confirm it’s you" (DOR-4906)'
---

### Fixed

- A mini app waiting for your OK no longer turns off "Confirm it’s you". Before, approving an updated mini app could fail because of that same update, or because of a different app’s update. DorkOS never loads a waiting app’s new code into the page, so it can’t get in the way. A mini app that is running changed code still turns confirming off, by name. After you update, you may need to sign in again once before confirming in the browser (DOR-4906)
