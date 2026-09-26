---
covers:
  - 'feat(cloud-api): withdraw the refunds route (DOR-2426)'
---

### Deprecated

- Withdraw `POST /v1/refunds` from `@dork-labs/cloud-api`. DorkOS Cloud does not offer refunds through its API, and the route was never served. `V1_ROUTES.refunds`, `RefundRequestSchema` and `RefundResponseSchema` stay exported so existing imports keep compiling, and are marked deprecated in the types and the JSON Schema until `/v2` removes them (DOR-2426).
