---
covers:
  - 'fix(server): a sign-in the browser would drop over plain http says why instead of looping (DOR-2968 part 3)'
---

### Fixed

- Signing in at a plain `http://` address on your network no longer drops you back on the sign-in screen with no reason. DorkOS now tells you the browser won't keep the sign-in, and to use `https` (DOR-2968).
