---
covers:
  - 'feat(decisions): bridges read their key on every request, cap an answer’s length and report its tokens (DOR-2788)'
  - 'feat(heartbeats): beats ask a cheap check first, and use DorkOS credits only after you say yes (DOR-2788)'
  - 'feat(profile): the Heartbeat page says where checks run and offers DorkOS credits once (DOR-2788)'
  - 'fix(heartbeats): review round 1 — refusals, a request-counted fuse, the offer and the stop signal (DOR-2788)'
---

### Added

- Agents can do their quick checks on DorkOS credits, so most check-ins end without a full run. Nothing is spent until you say yes. Each agent's Heartbeat page says where its checks run and how many it did today (DOR-2788)
