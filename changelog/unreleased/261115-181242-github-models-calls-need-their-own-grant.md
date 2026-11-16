---
covers:
  - 'fix(connectors): GitHub Models calls spend money, so Read never covers them (DOR-4460)'
---

### Security

- Keep agents from spending your money through GitHub. Asking a GitHub model for an answer can bill you, so it is no longer part of Read or Read and write, and runs only for an agent you picked it for. Reading issues and listing models still work under Read. (DOR-4460)
