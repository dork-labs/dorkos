---
covers:
  - 'feat(api): sign-in, step-up and device routes answer errors as problem documents (DOR-4979)'
  - 'fix(api): review round 1 on the sign-in and step-up problems (DOR-4979)'
---

### Changed

- More of the DorkOS API now answers errors in the standard `application/problem+json` format: confirming it's you (`/api/step-up`, `/api/person-session`), signed-in devices, sign-in checks, network access, remote access, the sign-in landing page, signing in with a passkey or a network code, the desktop app's own sign-in, and DorkOS's refusals around API keys and sign-in pages. Each answer carries `code`, the kind of problem, and `detail`, a sentence about what went wrong (DOR-4979)

### Note for people upgrading

- **This is a breaking change for scripts that call these parts of the API directly.** The old `error` field is gone from their error answers: read `code` for the kind of problem and `detail` for the message. Codes are now lower case with underscores, and the wait after too many wrong passwords is `retryAfterMs` (in milliseconds) instead of `retryAfterSeconds`. Sending no password to `/api/step-up` or `/api/person-session` now answers 400 `invalid_request` (it was `wrong-password`). A confirmation for a request that changed after it was held, and a chat route that changed while you were changing it, now answer 412 `precondition_failed` instead of 409. The DorkOS app and the desktop app already read the new format. Every old code and its new name is listed in the [API reference](https://github.com/dork-labs/dorkos/blob/main/contributing/api-reference.md#codes-that-changed-sign-in-step-up-and-devices) (DOR-4979)
