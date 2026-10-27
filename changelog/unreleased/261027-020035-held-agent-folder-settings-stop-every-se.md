---
covers:
  - 'fix(server): held agent folder settings stop every setting that runs code, and the runtime (DOR-3068)'
---

### Fixed

- While an agent's changed settings wait for your yes, none of its settings that run code take effect, and neither does a switch to another runtime. The agent keeps working on the default runtime until you allow the change.
