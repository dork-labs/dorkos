---
covers:
  - 'feat(server,client): every runtime says what its models can do, not just OpenCode (DOR-1672)'
---

### Changed

- The model menu now knows what Claude and Codex models can do, not just OpenCode ones. Every Claude and GPT-5 model says outright that it can use tools and that it does not make images, so the menu answers from a fact instead of a shrug (DOR-1672).
- A model whose runtime reports nothing about it is still treated as able to do the job. "We don't know" and "no" are different answers, and only a real "no" puts a model under **Can't do agent work**.
