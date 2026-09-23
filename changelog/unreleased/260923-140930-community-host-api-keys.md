---
covers:
  - 'feat(community): add host API keys for programs that manage communities'
  - 'fix(community): refuse re-rotating a replaced host key and harden key parsing'
---

### Added

- If you run a Community server, you can now give a program its own key instead of your password. Create one under **API keys** on the host page, choose what it may do (read community records, create communities, or suspend and resume them), and copy it once. A key can never read messages, files, or members, and it cannot create other keys. You can replace a key without downtime, or revoke it at once. A headless server can create its first key from the command line with `node dist-server/host-keys.js` (DOR-2253).
