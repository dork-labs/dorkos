---
covers:
  - 'fix(auth): preserve paid request admission during Room writes'
---

### Fixed

- Signed-in Room edits and repository setup work with single-use API keys. Revoked or expired credentials still stop writes.
