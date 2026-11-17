---
covers:
  - 'refactor(auth): bind confirmations to stored request hashes'
  - 'fix(approvals): confirm remote answers per request'
  - 'fix(approvals): preserve streamed request cards'
  - 'fix(approvals): confirm lasting decision effects'
  - 'fix(approvals): confirm Always allow on a capability card at the desk'
  - 'fix(approvals): confirm a settings card that turns spending up at the desk'
  - 'fix(approvals): confirm a permission change card at the desk'
  - "fix(approvals): the card waits for the server before saying it's allowed"
  - 'fix(approvals): the desk card shows the code its sheet asks you to check'
---

### Security

- Confirm approvals that grant lasting access with your password and a matching request code. Remote capability approvals also require confirmation.
