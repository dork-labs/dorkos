---
covers:
  - 'fix(client,e2e): the carrier setup opens itself, and the suites follow the surfaces that moved'
---

### Fixed

- On the Connections page, the "Composio & Nango" setup now opens on its own when you have nothing connected yet. Adding a key there is the only way to get services to show up, so it should not have been the thing tucked away. It used to stay shut every time, even on a brand new setup.
