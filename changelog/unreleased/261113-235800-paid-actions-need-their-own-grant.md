---
covers:
  - 'fix(connectors): an action that spends money needs its own grant, never Read (DOR-4204)'
---

### Security

- Keep agents from spending your money through an app they can only read. Actions on pay-per-use services, like an Apify scrape or an AI model call, are no longer part of Read or Read and write, are never shared with every agent, and run only for an agent you picked them for. (DOR-4204)
