---
covers:
  - 'fix(cloud): make DorkOS account money and account routes owner-only (DOR-2652)'
---

### Fixed

- Only you can spend from or change your DorkOS account now. Buying a plan or credits, opening billing, exporting or deleting the account, linking or unlinking this computer, changing seats, starting or moving a space, and choosing what runs on your DorkOS credits are refused for agents, and, with login on, for anyone signed in who isn't the owner of this DorkOS. The app shows the reason in one plain sentence instead of saying it couldn't reach your account (DOR-2652)
