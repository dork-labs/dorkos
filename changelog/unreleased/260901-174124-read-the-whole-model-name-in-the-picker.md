---
covers:
  - "fix(client): make the model picker fit a stranger's catalog (DOR-1673)"
  - 'fix(client): apply DOR-1673 adversarial-review findings'
  - "refactor(client): name the model-picker fixture for its runtime, and document the id line's edges"
---

### Fixed

- Read the whole model name in the model picker. The panel is wider, so a long name like "Qwen: Qwen3 Coder 480B A35B Instruct" and its note about what the model can't do both fit (DOR-1673)
- Stop cutting off the end of a model id. Two models can share everything but their last few characters, so when an id is too long to fit, the picker now trims the front and keeps the end (DOR-1673)
