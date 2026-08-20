---
covers:
  - 'fix(client): one failed action shows one error toast (DOR-1378)'
---

### Fixed

- One error now shows one message. Creating an agent, making a channel or DM, connecting or testing a messaging integration, turning a connection on or off, renaming a session, and a few onboarding steps could each pop two overlapping error toasts when something went wrong: one naming the action, one generic. Now there's exactly one, and it says what actually broke (DOR-1378).
