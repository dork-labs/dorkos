---
covers:
  - 'fix(evals): a rooms case runs on the runtime you asked for'
  - 'fix(evals): a Codex eval leg needs its own flag beside its own key'
  - 'fix(evals): a paid leg never containerizes, and records only the model that answered it'
---

### Fixed

- Eval runs of the `rooms` suite now use the runtime you name with `--runtime`. The agents each case sets up were always written down as Claude Code, so a run you pointed at OpenCode or Codex quietly went back to Claude Code and every turn failed (DOR-2207)
- An eval run that pays an outside account no longer runs in a container that has no network, whatever `--isolation` you left at its default, and a run on Codex now records no model rather than an Anthropic one that never answered it (DOR-2207)
- An eval run on Codex now asks you to decide before it spends. Codex bills an OpenAI account, and until now that run started on a key alone — so it needs `DORKOS_EVALS_PAID_CODEX=1` beside `CODEX_API_KEY`, the same way an OpenRouter run has always needed its own pair (DOR-2207)
