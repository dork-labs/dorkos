---
covers:
  - 'fix(auth): reject revoked cached sessions on write requests'
---

### Security

- Stop a revoked sign-in session from changing data through a cached cookie.
