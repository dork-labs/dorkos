---
covers:
  - 'fix(runtimes): refresh confirmed sign-ins through the shared config query'
  - 'fix(runtimes): keep excluded account aliases out of probes'
  - 'fix(runtimes): pause Claude accounts until their login is confirmed'
  - 'fix(runtimes): a new or changed Claude sign-in is a notice, never a pause (DOR-3245)'
  - 'test(server): an owner session from another device cannot start a Claude sign-in (DOR-3245)'
---

### Security

- Notice when a Claude account starts using a different sign-in. Your agents keep working, and you get one note in your inbox and one line in Activity. Until you keep the new sign-in in Settings → Runtimes, DorkOS won't move work to that account on its own. (DOR-3245)
- Add a Never use list in Settings → Runtimes. Put a folder or an organization on it, and DorkOS won't run agents there at any level. The list starts empty, and only you can change it. (DOR-3245)
