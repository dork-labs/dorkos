---
covers:
  - 'fix(runtimes): OpenCode and the DorkOS runtime refuse protected files from the shell too (DOR-4522)'
---

### Security

- Agents on OpenCode and the DorkOS runtime can no longer change your installed packages, the `dorkos` Terminal command, or DorkOS's other protected files from their shell, at any access level, Full included. Their file tools already refused these, and Claude Code and Codex already refused them from the shell. (DOR-4522)
