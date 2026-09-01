---
covers:
  - 'feat(evals,server): run evals against OpenCode on OpenRouter, gated on spend (DOR-1662)'
---

### Added

- Run the eval suite against models that are not Claude. A new `chat` suite checks the six things the chat pane owes you — a turn that ends once, a tool that runs and finishes, a permission prompt answered yes and answered no, a real cost coming back, the model you picked being the one that answered, and a model that does not exist saying so instead of spinning — and it runs the same way on Claude Code and on OpenCode through OpenRouter. A whole pass cost less than a cent when it was measured.
- Spending on an outside provider now takes two separate decisions. Set `DORKOS_EVALS_PAID_PROVIDER=1` **and** `OPENROUTER_API_KEY`, or nothing runs. A key on its own does nothing, because plenty of people leave one lying around and that is not the same as choosing to spend. What decides whether you are asked is what the run actually reaches, not which tier you named — so pointing any run at OpenCode, or at a provider, asks the same question. Runs also carry a 50-cent tripwire to stop a runaway loop, measured on the cost the harness can see.
