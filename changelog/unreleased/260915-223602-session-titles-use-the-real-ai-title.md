---
covers:
  - 'fix(sessions): a session started from a room titles itself, not the prompt that started it (DOR-2083)'
  - "fix(sessions): Claude Code sessions use the SDK's ai-title, not the first prompt (DOR-2083)"
  - 'fix(sessions): non-active-account renames and mention-stripping false positives (DOR-2083 review)'
---

### Fixed

- A session started from a room now gets the short title Claude Code writes for it, instead of showing the message that started it — including the @mention that routed it there. Renaming a session still wins over that title, and it updates on its own as soon as the new title is ready, with no need to reload the page. (DOR-2083)
