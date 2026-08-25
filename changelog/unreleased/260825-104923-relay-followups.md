---
covers:
  - 'chore(relay): undici declared explicitly, not implicitly through the root override (DOR-1544)'
  - 'fix(relay): the Slack adapter honors HTTP(S)_PROXY again (DOR-1542)'
  - 'test(relay): Slack fatal-error classification checked against the real SDKs (DOR-1543)'
---

### Fixed

- If DorkOS reaches Slack through a corporate proxy, it works again. The last Slack SDK upgrade (DOR-1528) quietly dropped support for `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` — an install behind one of those proxies could no longer connect to Slack at all. Set the proxy the same way you always have, and DorkOS picks it up (DOR-1542)
