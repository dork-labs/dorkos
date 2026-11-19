---
covers:
  - 'fix(connections): relinking your DorkOS account never brings back writes the Read and write update took away (DOR-4510)'
  - 'fix(connections): a relink still narrows the hosted side for what the write upgrade set aside, sending what the agent holds now (DOR-4510)'
---

### Fixed

- Linking your DorkOS account again no longer lets agents make changes in an app the recent Read and write update set back to Read, even if this computer's clock was wrong. Your agents stay on Read until you choose Read and write.
