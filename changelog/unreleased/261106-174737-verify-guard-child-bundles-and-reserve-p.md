---
covers:
  - 'fix(server): verify guard child bundles and reserve pending starts (DOR-3300)'
  - 'fix(server): refuse Bash collating and equivalence classes (DOR-3300)'
---

### Security

- Rebuild a changed copy of the shell-command check before starting it when DorkOS runs from source (DOR-3300).
- Keep simultaneous shell-command checks within their process limit, including after crashes (DOR-3300).
- Refuse shell writes to agent setup files when Bash uses special character patterns in the path (DOR-3300).
