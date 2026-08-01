---
covers:
  - 'fix(server): an OpenCode approval clears its card without waiting on the sidecar'
---

### Fixed

- Approving or denying a tool in an OpenCode session now clears the card right away. It used to wait for OpenCode to confirm the answer, and if that confirmation never arrived the card sat there and the session stayed stuck as "waiting on you", blocking the next message.
