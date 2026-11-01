---
covers:
  - 'fix(spaces): a caller can no longer pick its own sign-in limit by sending a forwarded address (DOR-2846)'
---

### Security

- On a space with no proxy in front, someone could send a made-up forwarded address with each sign-in attempt and get a fresh attempt limit every time. Sign-in limits and the address a session records now use the real connection, or the proxy's header when the host names one. (DOR-2846)
