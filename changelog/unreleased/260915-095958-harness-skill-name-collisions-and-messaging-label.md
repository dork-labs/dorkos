---
covers:
  - 'fix(harness): one skill name in two tool folders is a collision each tool is told about (DOR-1940)'
  - 'fix(marketplace): the install preview says messaging connections, not the retired noun (DOR-1936)'
  - 'fix(marketplace): the package page says Connections, not the retired nouns (DOR-1936)'
---

### Fixed

- Tell you when one skill name is in two folders the same agent tool reads. If `review-pr` lives in both `.claude/skills` and `.opencode/skills`, OpenCode sees two skills under one name — DorkOS now says so beside both of them, along with what that tool's own documentation says happens: one of them loses, both load, or nobody wrote it down. Both copies still show as read by the tool, because both really do load (DOR-1940)
- Say what a marketplace package does in plain words on its page at dorkos.ai. A package that hooks DorkOS up to something outside now reads "Adds connections" instead of "Installs messaging adapters" — which was wrong twice over, since that kind of package can be a Telegram bot or an account DorkOS acts through, not only messaging (DOR-1936)
- Rename the marketplace's "Integrations" category to "Connections", and describe it as "Ways to hook DorkOS up to outside services." Links to the category page are unchanged (DOR-1936)
