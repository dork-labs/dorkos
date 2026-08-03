---
covers:
  - 'feat(server): agents keep their connected accounts across a restart (DOR-856)'
  - 'fix(server): a chat can no longer reach two different agents at once (DOR-856)'
  - "feat(server): a stranger's first message to your bot is now a card you can act on (DOR-856)"
---

### Added

- Connecting an account (Gmail, Slack, and the rest) to an agent now sticks —
  restart DorkOS and every session that agent starts still has the account's
  tools, without reconnecting by hand. A single session can still add or
  remove an account just for itself.
- When a stranger messages a Telegram or Slack bot nobody connected to an
  agent, DorkOS now keeps a quiet record of who wrote and when instead of
  dropping the message with no trace — the message text itself is never
  stored or read. Claim it to an agent, mute it, or block the chat outright.
  The bot stays silent until you decide.

### Fixed

- Two people could end up messaging the same Telegram or Slack chat and
  quietly land on two different agents, with no warning either had happened.
  Connecting a chat to an agent is now exclusive — trying to connect an
  already-connected chat tells you which agent has it, instead of silently
  losing the older connection.
