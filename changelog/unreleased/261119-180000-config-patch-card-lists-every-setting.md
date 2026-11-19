---
covers:
  - 'fix(approvals): a config_patch card lists every changed key, riskiest first'
  - "fix(approvals): a settings card names its riskiest settings and never shortens a person's"
---

### Security

- When an agent asks to change several settings at once, the approval card now names the riskiest first and lists every one in full, so nothing hides off the edge. A change too large to show whole is turned down, and a card with any setting only you may change never offers Always allow (DOR-4778)
