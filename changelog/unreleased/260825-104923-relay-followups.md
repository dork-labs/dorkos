---
covers:
  - 'chore(relay): undici declared explicitly, not implicitly through the root override (DOR-1544)'
  - 'fix(relay): the Slack adapter honors HTTP(S)_PROXY again (DOR-1542)'
  - 'test(relay): Slack fatal-error classification checked against the real SDKs (DOR-1543)'
  - 'fix(relay): the proxy transport is tested, closed, and scoped to HTTP(S)_PROXY (DOR-1542 review)'
---

### Changed

- Slack works through a corporate proxy. Set `HTTP_PROXY` or `HTTPS_PROXY` the way you always have, and DorkOS picks it up (DOR-1542)
