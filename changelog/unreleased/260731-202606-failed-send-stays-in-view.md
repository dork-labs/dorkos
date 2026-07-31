---
covers:
  - 'fix(rooms): the scroll pin follows a message of your own, so a failed send stays in view (DOR-799)'
---

### Fixed

- A message that fails to send now stays on screen. It used to slide below the bottom of the conversation the moment it appeared, so once the error notice faded there was nothing left to tell you it never went — and no way to try again (DOR-799).
