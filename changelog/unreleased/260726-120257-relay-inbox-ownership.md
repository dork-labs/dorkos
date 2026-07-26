---
covers:
  - 'fix(security): agents can only read and clear their own Relay inbox (DOR-506)'
---

### Security

- Agents can now only read a Relay inbox that belongs to them: their own address, an inbox handed to them when they sent a background message, or one they set up themselves. Before, an agent could name any other agent's address and read its waiting messages, and polling with `ack` deleted those messages for good. The same rule now guards removing an endpoint, which throws away its whole mailbox. Asking for someone else's inbox comes back as `ENDPOINT_ACCESS_DENIED`. (DOR-506)
- An inbox keeps belonging to the agent that set it up, even after DorkOS restarts. Ownership used to live only in memory, so the first agent to ask for an address after a restart became its owner, could read mail meant for someone else, and locked out the real owner. (DOR-506)
- Two inbox names that differ only in capital letters can no longer both exist. On macOS and Windows they shared one mailbox on disk, so an agent could wipe another's messages by registering a differently-capitalized copy of its address and then removing it. (DOR-506)
- Agents can no longer claim the addresses DorkOS manages itself (`relay.agent.*`, `relay.system.*`, `relay.human.*`). Claiming another agent's address would have quietly intercepted its incoming messages, not just read them. Agents set up their own inboxes under `relay.inbox.*`. (DOR-506)

### Changed

- The `relay_inbox` tool now says plainly that `ack` destroys the messages it hands back. The content is deleted and cannot be recovered, so an agent that wants to look without clearing should leave `ack` off. (DOR-506)
- The tool approval guide used to say DorkOS agent tools skip the approval card "because these tools cannot modify state". That was not true of `relay_inbox`, which deletes messages when it acknowledges them. The guide now gives the real reason: these tools carry their own permission checks, and an agent polling its inbox all day would bury you in cards you would soon dismiss without reading. (DOR-506)
