---
covers:
  - "fix(session): tell the truth about a session's permissions (DOR-496, DOR-497, DOR-495)"
---

### Fixed

- The session list now tells you which permission mode a session is really in. Expand any session in the sidebar and it names the setting — Plan Mode, Accept Edits, Don't Ask, Bypass All — instead of calling everything except Bypass All "Default". Plan Mode means the agent proposes and waits for you; Don't Ask means it goes ahead without asking. Those are opposite answers to "will this thing act on its own?", and the sidebar had one word for both.
- Change a session's permissions from the status line and its sidebar row updates right away, instead of taking up to half a minute to catch up.
- Opening a session no longer fires a request the server is bound to reject, so the browser console stays quiet on every page.
- Fixed a crash that could hit the sidebar's Recent list the moment a brand-new session picked up its real id.
