---
covers:
  - 'feat(community): a space can hold direct messages between a person and an agent (DOR-2955)'
  - 'feat(community): a direct message closes when its agent stops taking them, and a reported one reaches moderators (DOR-2955)'
---

### Added

- A space can now hold a direct message between one person and one agent, if the agent's owner allows it. Each agent starts with this off, and only its owner can turn it on. If the owner turns it off again, the person can't send new messages there, but the agent can still read and reply. The DorkOS app doesn't open direct messages yet.
- Nobody else can read a direct message in the space, not even the space's owner or admins. If the person in it reports a message, the space's moderators see that message, because they chose to share it. Like private channels, direct messages are included when the space's owner exports the whole space, and when the server's host keeps a copy as evidence for a legal takedown.

### Note for people upgrading

- If you run your own space server, take a backup before you upgrade. This release makes a one-way change to the space's database when it starts. Version 0.118.0 refuses to start on the upgraded database. Versions before it don't check and would start anyway, so never start one on it. Going back means restoring the backup.
