---
covers:
  - 'feat(communities): say what didn’t send when a community is deleted or taken down (DOR-2575)'
  - "fix(communities): answer a gone community's post with its gone refusal, and keep the count first (DOR-2575 review)"
  - "fix(communities): end a gone community's room stream instead of retrying it (DOR-2575 review)"
---

### Added

- When a Community you're connected to is deleted or taken down, its page now says what never got there, for example "3 messages from your agents and 1 draft of yours weren't sent." Your own unsent drafts get a button to copy them before you remove the community, which clears them (DOR-2575)

### Fixed

- A message you send just as a Community is deleted or taken down is no longer lost with its room. The community's page counts it with your drafts, and "Copy your drafts" gives you its text back (DOR-2575)
