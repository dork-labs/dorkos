---
covers:
  - "fix(site): end a revoked machine's app sign-ins at the service (DOR-2518, DOR-2474)"
  - 'fix(site): never strand or block revoked-instance cleanup and account erasure (DOR-2518 review)'
  - 'fix(site): anchor the erasure deadline at the revocation and trace rebound deletions (DOR-2518 review 2)'
---

### Fixed

- Revoking a linked instance from your DorkOS account now signs its apps out at the service too. Before, an app you connected through your DorkOS account (your Gmail, say) stayed signed in there after the link ended, with no way left to reach it. If the service can't be reached at that moment, DorkOS keeps trying until the sign-in is gone.
- Deleting your DorkOS account now signs every app you connected through it out at the service first. If one can't be signed out yet, you land back on your account page with a note that this can take up to a day and to request deletion again from there later, so no sign-in is left behind with no record of it. A deletion is never held up for more than a day: past that, your account is deleted anyway and DorkOS records exactly which sign-in is left so it can be ended by hand.
- A change to DorkOS's own connection settings no longer leaves a revoked computer's sign-ins stuck at the service, and an app that was already disconnected stays disconnected through that change.
- Turning a DorkOS-account app back on after it was removed at the service now stops with a clear reason instead of retrying every hour forever.
