---
covers:
  - "fix(desktop): the Mac app reads a company network's certificates from NODE_EXTRA_CA_CERTS itself (DOR-3361)"
---

### Changed

- If your company's network needs its own certificates, and you point `NODE_EXTRA_CA_CERTS` at them, the Mac app keeps trusting them. It now reads that file itself, so its connections keep working on that network.
