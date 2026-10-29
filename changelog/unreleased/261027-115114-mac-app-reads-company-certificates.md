---
covers:
  - "fix(desktop): the Mac app reads a company network's certificates from NODE_EXTRA_CA_CERTS itself (DOR-3361)"
  - 'fix(desktop): the Mac app trusts company certificates only from a path you set in Settings (DOR-3361)'
---

### Changed

- If your company's network needs its own certificates, choose the certificate file in **Settings → Server → Network**. The Mac app trusts that file only, and shows how many certificates it trusts from it. It does not use `NODE_EXTRA_CA_CERTS`, because any program on your computer could set it. Agents can't change this setting.
