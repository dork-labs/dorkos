---
covers:
  - 'fix(server): one origin policy, and rate limits stop trusting spoofable headers (DOR-1711)'
---

### Security

- Rate limits now count by connection instead of by a header anyone can write. DorkOS was reading the client's address from `X-Forwarded-For`, which is fine behind a proxy and free to fake without one — so someone guessing your password could put a new value in that header on every try and never run out of attempts. All six limits count honestly now: sign-in, the MCP endpoint, the agent-to-agent endpoints, extension data proxies, the connection test for agent messaging, and the admin restart and reset buttons — that last one guards the button that erases everything DorkOS has stored, so it is the one you would least want a stranger to be able to keep retrying. If a proxy you control really is the only way in and you want it counted per person behind it, set `DORKOS_TRUST_PROXY=true` (DOR-1711)
- The MCP endpoints now check where a browser request came from the same way the rest of DorkOS does. They had their own shorter list, which quietly refused addresses everything else accepted — the IPv6 spelling of localhost, a container published on a different port, and any address you listed in `DORKOS_CORS_ORIGIN`. Those work now, and the protection against a malicious page pointing your own address at itself is unchanged (DOR-1711, DOR-553)
- The addresses you list in `DORKOS_CORS_ORIGIN` are now added to the ones DorkOS already trusts, rather than standing in for them. Before, listing your public address could stop the app's own live connection from opening and stop you signing in, because those two checks read the list as the complete answer while the rest of the app did not (DOR-1711)
