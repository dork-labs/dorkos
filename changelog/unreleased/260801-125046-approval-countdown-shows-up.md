---
covers:
  - 'feat(approvals): say why you said no, and see how long you have (DOR-809, DOR-810)'
---

### Fixed

- **The approval card shows how long you have.** A request for permission waits ten minutes and is then refused for you so the agent can carry on. The card was built to show that as a draining bar, an amber warning at two minutes and a red one at the last minute — but the deadline never reached the browser, so no live session ever saw any of it. It does now, including on a card you come back to after a reload or in a second window, where the bar picks up where the clock actually is instead of starting over.
- **The card above the composer knows what it is asking about again.** The permission card in the input zone had lost the details the agent sent with the request — what it wants to do, which file triggered it, why it is asking — and was showing only a tool name. It shows the full ask again.
