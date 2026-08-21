---
covers:
  - 'feat(shared,server): the launch-account ladder — registry ids, defaultAccount, and a per-session hint (DOR-1407)'
  - 'test(server,shared): pin all five billing-account invariants, plus docs (DOR-1407)'
---

### Changed

- The Claude account you pick in Settings is now called your **default
  account** — new chats bill it unless something more specific says otherwise.
  Your current choice carries over, and each account you have registered gets a
  short name of its own so other settings can point at it later (DOR-1407)
