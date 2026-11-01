---
covers:
  - 'fix(server): stop the secret denies refusing a credentials/ folder, and log each refusal (DOR-3510)'
---

### Fixed

- An agent on Claude Code can open files in a folder named `credentials/` again, such as `docs/credentials/`. Only the real AWS credentials file stays blocked. (DOR-3510)
