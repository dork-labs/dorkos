---
covers:
  - 'fix(codex): restore reliable sessions and agent tools'
---

### Fixed

- Codex now uses a current version and offers the models available to your signed-in account. New Codex agents start with the runtime you selected.
- Rejected models explain what to change, with a button that opens the model menu. Informational warnings no longer appear as errors.
- Codex and OpenCode agents can use their DorkOS tools while app login is enabled. Each turn keeps the permissions it started with.
- Codex’s context gauge now shows the current conversation size and effective limit reported by Codex, instead of counting earlier requests again.
- Collapsed tool results now show an arrow and an ellipsis, so a result with hidden contents no longer looks empty.
