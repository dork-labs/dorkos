---
covers:
  - 'feat(client): show when a chat runs out of usage, and what happened after (DOR-2382)'
---

### Added

- When a chat runs out of usage, a notice above the message box now says which account (or Claude, Codex or OpenCode, with one account) ran out and when it comes back. It shows what you can do: wait for the reset, keep going on another model, or, with two or more Claude accounts, continue on another account. When the work is about to move to another account by itself, it counts down and lets you move now, pick another account, or wait instead. (DOR-2382, DOR-2388)
- While you wait, the notice counts down to the reset. With a Claude account you can tick "Continue automatically when it resets". Once the reset comes, one click continues the chat where it left off. (DOR-2382)
- When it's over, a one-line note in the chat says what happened, such as "Acct 4 ran out · moved to Acct 2 at 2:14pm" or "Resumed after reset at 4:02pm". (DOR-2382)
