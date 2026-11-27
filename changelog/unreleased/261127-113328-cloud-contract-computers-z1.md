---
covers:
  - 'feat(cloud-api): a cloud agent computer can stop for its time limit, is never stopped mid-turn, and can wake its home (DOR-5363)'
---

### Added

- `@dork-labs/cloud-api` adds the stop reason `time_limit` for a cloud agent computer that ran six hours without a break, publishes its idle window (`AGENT_COMPUTER_IDLE_WINDOW_SECONDS`), and says the hosted service begins no idle stop while a computer's `busy: true` holds. A cloud agent computer may now ask to wake its own DorkOS in the cloud when it owes it something, and the contract states that a home keeps itself awake while a start it asked for is outstanding or one of its computers is connected. Nothing in the app uses these yet, so nothing you see changes (DOR-5363).

### Changed

- The cloud agent computer schemas moved from `hubs.ts` to `agent-computers.ts`, and `hubs.ts`'s overview of a person's DorkOS in the cloud moved to `hub-assignment.ts`, so `hubs.ts` is gone. The package root exports the same names (DOR-5363).
