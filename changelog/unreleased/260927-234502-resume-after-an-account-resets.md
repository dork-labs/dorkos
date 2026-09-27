---
covers:
  - "feat(sessions): wait for an account's reset, confirm it with a reading, and resume the session by itself (DOR-2382)"
---

### Added

- When you choose to wait for an account's reset, DorkOS now picks the session back up by itself once the reset has happened. It does not go by the clock alone: it waits until a fresh usage reading shows the account has room again, then sends the session one message: "Your account's usage has reset. Continue where you left off." If it needs your approval, the request is turned down instead of waiting (DOR-2382).
- You get one notice per account when it comes back, saying how many paused sessions can continue (DOR-2382).
- A session is picked up by itself at most once per reset. If it runs out again before the next reset, it waits for you instead. If too many sessions nobody typed into are already running, it tries again each minute. A session that a room, a schedule or a chat connection started is never picked up by itself; it shows as ready for you (DOR-2382).
- If no reading can confirm the reset within a short while, the session shows as ready but is not picked up by itself, so you can decide. Waits survive a restart of DorkOS (DOR-2382).
