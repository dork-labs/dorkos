---
covers:
  - 'feat(agents): agents look up the answer in the DorkOS docs (DOR-661)'
---

### Added

- Ask an agent how DorkOS works and it looks the answer up instead of guessing. Agents now come with a skill that searches the DorkOS documentation. It reads the one page that answers your question, then tells you which page it came from. When the docs do not cover something, it says so plainly rather than inventing an answer. DorkBot picks this up the next time DorkOS starts. Every agent you create from now on has it too (DOR-661)
