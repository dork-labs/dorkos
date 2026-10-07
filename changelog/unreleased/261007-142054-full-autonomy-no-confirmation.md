---
covers:
  - 'feat(trust): retire the Full-autonomy acknowledgement (DOR-2739)'
  - 'refactor(trust): drop a stale onError mention and an unused import (DOR-2739)'
---

### Changed

- Choosing Full autonomy no longer opens an extra confirmation. You pick it like any other level, in a chat, in Settings, on an agent's page or from the command line, and it takes effect straight away (DOR-2739)

### Removed

- The `dorkos config acknowledge-autonomy` command, and the saved "don't show this again" date it wrote. Neither is needed any more (DOR-2739)
