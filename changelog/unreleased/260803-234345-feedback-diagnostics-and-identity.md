---
covers:
  - 'feat(feedback): bug reports carry diagnostics and signed-in identity automatically (DOR-317)'
---

### Added

- **Bug reports now include basic system info automatically.** When you send a
  bug report, DorkOS quietly attaches your version, platform, and configured
  runtimes, plus a short trail of what just went wrong (recent errors, failed
  requests, a dropped connection) — the same safe details already shown on the
  "Report on GitHub" path. It helps the team reproduce problems without asking
  you to describe your setup by hand.
- **Signed-in reports are attributed automatically.** If you're signed in when
  you send feedback, DorkOS attaches your account email and name so the team
  can follow up without you retyping a contact address. Signed out, or with
  login off, feedback still sends anonymously as before.
