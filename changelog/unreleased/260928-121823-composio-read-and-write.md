---
covers:
  - 'feat(connections): give Composio apps a real "Read and write" level (DOR-2466)'
  - 'fix(connections): classify Composio actions by their safety hints only (DOR-2466)'
  - 'fix(connections): keep Composio sharing, forwarding and subscriptions out of levels (DOR-2466)'
  - 'fix(connections): keep Composio automatic replies out of levels (DOR-2466)'
  - 'fix(connections): give only audited Composio apps a write tier (DOR-2466)'
  - 'fix(connections): test every account-reach word and tighten Composio level wording (DOR-2466)'
---

### Added

- Gmail and Google Calendar can now be shared with agents as "Read and write" instead of only "Read". With it, agents can send, create and edit things, like sending an email or adding a calendar event. Agents still can't delete, share your calendar, forward or redirect mail, change who your mail is sent as, change many messages at once, move an event to another calendar, or turn on an automatic reply: you allow those one action at a time. "Read" also now covers reads that used to need your approval one at a time, such as reading a draft or finding free time in your calendar. Other apps connected through Composio keep offering "Read" only for now. No agent's access grows on its own. If you connected an app through your DorkOS account and allowed an agent one of its actions one at a time, you may need to allow it again (DOR-2466)
