---
covers:
  - "fix(server): stream upgrades require the connection's own scheme when no proxy declares one (DOR-932)"
---

### Security

- Live-update connections now require the same scheme (`http` or `https`) as the page that
  opened them when no reverse proxy declares one. This closes a gap where an unusual proxy
  setup could let a plain `http` page open a secure cockpit's stream. If you run a custom
  TLS-terminating proxy, set the `X-Forwarded-Proto` header on it — a proxy that omits it
  will now have its upgrade requests rejected instead of silently accepted (DOR-932)
