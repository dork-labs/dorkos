---
covers:
  - 'fix(server,client): the app can create your owner login from any address you allow (DOR-1744)'
  - 'fix(server): the literal string "null" never reaches Better Auth''s allowlist (DOR-1744)'
  - 'fix(server): the auth allowlist takes only http(s) origins, and says it guards redirects too (DOR-1744)'
---

### Fixed

- Creating your owner login now works from any address you have allowed the server to answer.
  Before, the server would load the whole app and then turn the sign-up away, which blocked
  Remote Access setup. This hit the desktop app in development every time (DOR-1744)
- Sign-in and sign-up errors now say what went wrong in plain words. A refused address used to
  show only "Invalid origin"; you now get a sentence, the address to allow, and the original
  wording underneath (DOR-1744)
