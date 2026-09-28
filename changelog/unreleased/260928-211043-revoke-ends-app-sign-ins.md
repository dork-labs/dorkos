---
covers:
  - "fix(site): end a revoked machine's app sign-ins at the service (DOR-2518, DOR-2474)"
---

### Fixed

- Revoking a linked instance from your DorkOS account now signs its apps out at the service too. Before, an app you connected through your DorkOS account (your Gmail, say) stayed signed in there after the link ended, with no way left to reach it. If the service can't be reached at that moment, DorkOS keeps trying until the sign-in is gone.
- Deleting your DorkOS account now signs every app you connected through it out at the service first. If one can't be signed out yet, the account isn't deleted, and you're asked to try again in a few minutes, so no sign-in is left behind with no record of it.
- Turning a DorkOS-account app back on after it was removed at the service now stops with a clear reason instead of retrying every hour forever.
