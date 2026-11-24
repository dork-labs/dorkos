---
covers:
  - 'feat(api): sign-in, step-up and device routes answer errors as problem documents (DOR-4979)'
---

### Changed

- More of the DorkOS API now answers errors in the standard `application/problem+json` format: confirming it's you (`/api/step-up`, `/api/person-session`), signed-in devices, sign-in checks, network access, remote access, the sign-in landing page, signing in with a passkey or a network code, the desktop app's own sign-in, and DorkOS's refusals around API keys and sign-in pages. Each answer carries `code`, the kind of problem, and `detail`, a sentence about what went wrong (DOR-4979)

### Note for people upgrading

- **This is a breaking change for scripts that call these parts of the API directly.** The old `error` field is gone from their error answers: read `code` for the kind of problem and `detail` for the message. Codes are now lower case with underscores. Extra facts sit beside `code` in the same answer: `triesLeft`, `minLength`, `blockedBy` and `stale` as before, and the wait after too many wrong passwords is now `retryAfterMs` (in milliseconds) instead of `retryAfterSeconds`. The DorkOS app and the desktop app already read the new format (DOR-4979)
- **Step-up codes, now lower case:** `wrong-password` is `wrong_password`, `too-many-tries` is `too_many_tries`, `password-too-short` is `password_too_short`, `no-password` is `no_password`, `no-owner` is `no_owner`, `insecure-connection` is `insecure_connection`, `extension-risk` is `extension_risk`, `stale-sign-in` is `stale_sign_in` and `stale-page` is `stale_page`. `too-many-attempts` is `rate_limited`, `not-a-person` is `person_only`, `not-your-action` is `forbidden`, `new-password-invalid` is `invalid_request`, and `different-request` is `precondition_failed` (DOR-4979)
- **Other codes, now lower case:** `PASSKEY_NEEDED` is `passkey_needed`, `PASSKEY_ON_OTHER_ADDRESS` is `passkey_on_other_address`, `PASSKEY_REFUSED` on a passkey check is `passkey_refused`, `AUTH_REQUIRED_FOR_EXPOSURE` (from network access and remote access) is `auth_required_for_exposure`, `SIGN_IN_NEEDS_HTTPS` is `sign_in_needs_https`, `LAN_ACCESS_UNSUPPORTED` is `lan_access_unsupported`, `LAN_ACCESS_SET_BY_ENVIRONMENT` is `set_by_environment`, and `SIGNIN_NO_RETRY` is `signin_no_retry` (DOR-4979)
- **Codes folded into a shared one** (`detail` still says which):
  - `person_only` (403): `DEVICES_PEOPLE_ONLY`, `person_required`, `operator_cookie_required` and `operator_only_config` on these routes.
  - `operator_only` (403): `NEEDS_PERSON_AT_THIS_COMPUTER`, `REMOTE_SETUP_NEEDS_THIS_COMPUTER`, `API_KEY_NEEDS_THIS_COMPUTER`, `NOT_AT_THIS_COMPUTER`, and `not-at-this-computer` from `/api/person-session`.
  - `not_from_wifi` (403): `NOT_FROM_WIFI` from the network level and `WIFI_SIGN_IN_NEEDS_CODE`.
  - `origin_not_allowed` (403): `NOT_FROM_OWN_PAGE` and `PASSKEY_ORIGIN`.
  - `owner_only` (403): `SIGN_IN_FIRST`.
  - `invalid_request` (400): `INVALID_BODY`, `INVALID_MODE`, `NOT_BINDABLE`, `CODE_REFUSED`, and `PASSKEY_REFUSED` when adding a passkey.
  - `not_found` (404): `DEVICE_NOT_FOUND`, `REQUEST_ENDED`, `NOT_FOUND`. A sign-in landing page that is gone (`SIGNIN_LANDING_GONE`) is `expired`, still 404.
  - `rate_limited` (429): `too-many-actions` and too many network sign-in requests or tries.
  - `remote_access_unavailable` (409): `MANAGED_REMOTE_UNAVAILABLE`. `conflict` (409): `MANAGED_REMOTE_ALREADY_SET_UP` and `MANAGED_REMOTE_NOT_SET_UP`. `upstream_unavailable` (502): `MANAGED_REMOTE_SETUP_FAILED` and `SIGNIN_RETRY_FAILED`.
  - `internal_error` (500): `STEP_UP_COMMIT_FAILED` and `SIGN_OUT_FAILED`.
- **Status changes on these routes:** a confirmation for a request that changed after it was held (`different-request`), and a chat-connection change judged on a connection that has since changed (`BINDING_CHANGED`), are now 412 `precondition_failed`, not 409 (DOR-4979)
