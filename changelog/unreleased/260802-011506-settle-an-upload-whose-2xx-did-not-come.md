---
covers:
  - 'fix(chat): settle an upload whose 2xx did not come from DorkOS (DOR-494 review)'
---

### Fixed

- Some wifi networks answer for you — the hotel or cafe sign-in page that appears before you're online. When one of those replied to an attachment upload, DorkOS took it for an answer it could not read and sat on a spinner that never stopped, with the Cancel button unable to help. It now says the upload got an unexpected reply, so you can sign in to the network and try again. (DOR-494)
