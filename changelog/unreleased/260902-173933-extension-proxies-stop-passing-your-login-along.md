---
covers:
  - 'fix(server,client): extension proxies stop leaking your DorkOS login'
---

### Security

- Extensions that forward requests to an outside service (a "data proxy", like one that talks to GitHub for you) were also handing that service your DorkOS login — the cookie or key that proves the request came from you. It never needed to go: the extension already carries its own credential for the service it talks to. Your login now stops at DorkOS.
- The same proxies got three more limits. They can only reach the address the extension declared, so a crafted request can no longer walk up to a neighbouring part of that service with the extension's key attached. If the service answers with a redirect, DorkOS hands the redirect back to whoever asked instead of following it with the key. And there is now a ceiling of 120 requests a minute, so nothing can quietly burn through your quota at that service.
- `DORKOS_CORS_ORIGIN="*"` no longer opens the whole API to every website. Logging in is off by default, so a wildcard meant any page you happened to visit could read your sessions and files and start turns of its own. DorkOS now ignores the `*`, says so at startup, and tells you to list the exact addresses you want to allow — the same rule live connections have always followed. Listing real addresses works exactly as before.
- Every response now says it must not be second-guessed about what kind of file it is, instead of only the handful of routes that said it themselves.
