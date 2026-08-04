---
covers:
  - 'fix(client): screen readers say the field name, not the asterisk (DOR-651)'
---

### Fixed

- When you set up Telegram or Slack, required fields (like DM Access or an API key) show a red asterisk next to the label. Screen readers used to read that asterisk out loud as part of the field's name, like "DM Access star". Now they just read the plain field name, and the asterisk still shows for sighted users.
