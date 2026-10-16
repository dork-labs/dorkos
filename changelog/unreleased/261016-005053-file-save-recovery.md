---
covers:
  - 'feat(canvas): review and recover previous file saves'
  - 'fix(canvas): settle idle file-save recovery work'
  - 'test(client): preserve exact focus-ring audit with fewer parses'
  - 'fix(client): scope recovery discovery to its observed binding'
  - 'test(e2e): retain failed file-save recovery traces'
  - 'test(e2e): wait for the app shell before opening the right panel'
  - 'test(client): avoid parsing files without raw status colours'
  - 'ci(test): split unit file work across six shards'
---

### Added

- Review a document’s previous saves and recover missing confirmations without resending edits.
