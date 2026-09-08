---
covers:
  - 'fix(client): a remembered tunnel is not a running one'
---

### Fixed

- Opening DorkOS no longer shows remote access as on, or offers a link and QR code for it, when the tunnel stopped since you were last here. DorkOS was reading what your browser remembered about remote access as if the server had just said it.
- No more "Remote access turned off" alert on a visit where nobody turned anything off. That message now only appears when remote access actually drops while you are looking.
