---
covers:
  - 'fix(codex): refuse protected file-change approvals (DOR-3597)'
  - 'fix(codex): reject Git metadata identity aliases (DOR-3597)'
---

### Security

- Refuse Codex approval requests that change protected files, including mixed patches and renamed files. The Full access choice now says file safeguards still apply.
