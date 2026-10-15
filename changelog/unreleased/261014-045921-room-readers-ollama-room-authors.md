---
covers:
  - 'fix(runtime): preserve Room readers and native turn allowances'
---

### Fixed

- Defer Ollama endpoint configuration until probing or pulling, while retaining
  loopback validation.
- Support Room Git commits for caller display names with Git-special characters.
- Keep live and persisted Room readers usable after daily database backups by
  copying through a separate owned read-only connection.
- Refresh outsider output allowances for each genuine original native turn,
  preserving per-turn limits and refusing repeated-observation resets.
