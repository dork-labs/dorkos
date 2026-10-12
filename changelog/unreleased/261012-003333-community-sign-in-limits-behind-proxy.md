---
covers:
  - "fix(community): Better Auth's own sign-in limits read the trusted proxy header too (DOR-2552)"
---

### Fixed

- A Community server behind a proxy with `COMMUNITY_TRUSTED_PROXY_HEADER` set now counts sign-in attempts per visitor. Before, sign-in limits saw the proxy's address for everyone, so they either limited nobody or everybody together.
