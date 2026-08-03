---
covers:
  - 'docs(spec): connection-scoping backend spec — attachment ladder, one-chat-one-agent, claim feed (DOR-856)'
  - 'feat(db): add connector-attachment and unclaimed-chat tables (migration 0048, DOR-856)'
  - 'feat(server): persisted agent-level connector attachment with a session-override ladder (DOR-856)'
  - 'feat(server): enforce one chat, one agent — binding uniqueness, move, and an enabled-filter fix (DOR-856)'
  - 'feat(server): a durable claim feed for unbound inbound chats (DOR-856)'
  - 'docs(server): register the new connector/binding/claim-feed endpoints in OpenAPI (DOR-856)'
  - 'docs(spec): mark connection-scoping implemented (DOR-856)'
  - 'fix(server): stop deleting bindings on a legacy chatId collision — disable in place, back up to a sidecar (DOR-856 review)'
  - 'fix(server): hydrateSession survives a provider failure and a session rekey (DOR-856 review)'
  - 'fix(server): cap the claim feed, rate-limit its broadcasts, and fix block-check ordering (DOR-856 review)'
  - 'fix(server): agent deletion clears standing connector consent; agent-attach validates the agent exists (DOR-856 review)'
  - 'docs(server): design-decisions D3-addendum..D14, regenerated OpenAPI, changelog fixes (DOR-856 review)'
  - 'fix(server): dedupeChatCollisions ignores already-disabled losers, so a restart is not a repeat reconciliation (DOR-856 verification)'
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
  quietly land on two different agents, with no warning either had happened —
  whoever connected the chat SECOND had no idea their connection was silently
  going nowhere. Connecting a chat to an agent is now exclusive — trying to
  connect an already-connected chat tells you which agent already has it,
  instead of quietly losing the newer connection with no error.
