---
covers:
  - 'fix(connectors): connect services that sign in with a key, and Monday'
---

### Fixed

- Connecting a service that signs in with a key, such as PostHog or 1Password, failed with "isn't available right now", every time. It now asks for your key and connects. Monday could not be connected at all; it now signs in like other apps.
