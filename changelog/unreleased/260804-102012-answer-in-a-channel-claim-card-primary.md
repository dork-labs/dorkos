---
covers:
  - 'feat(shared): claim request/response schema carries the bridge field (DOR-882)'
  - 'feat(server): claim card primary action creates claim, binding, and bridge atomically (DOR-882)'
  - 'feat(client): "Answer in a channel" and "Answer privately" on the claim card (DOR-882)'
---

### Added

- When someone messages a bot you haven't set up yet, the claim card now offers two ways to answer: "Answer in a channel" sets up a room for that chat in one step, or "Answer privately" keeps it as a single chat, same as before. Choosing an agent still never happens automatically — nothing runs, and nothing is spent, until you decide. If a channel can't be set up (for example, the chat turns out to be a broadcast), the chat is still answered privately and the card says why. (DOR-882)
