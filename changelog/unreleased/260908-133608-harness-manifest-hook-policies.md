---
covers:
  - 'feat(harness): hook policies are honoured, four keys retire (DOR-1858)'
  - 'fix(harness): --allow-hooks refuses a yes a policy suppresses (DOR-1858)'
  - 'fix(harness): --allow-hooks refuses when nothing can take them (DOR-1858)'
---

### Changed

- Your project's `.agents/harness.manifest.json` can say what to do with your hooks for each agent, and DorkOS now does what it says. `none` means that agent's hooks file is not written, and the report says so instead of quietly writing it anyway; `generate` is what DorkOS has always done; say nothing about an agent and nothing changes for it. If DorkOS had already written that file, `dorkos harness sync --fix` clears it away — and never touches one you wrote yourself. For Claude Code, which reads your hooks straight out of `.claude/settings.json` whatever your manifest says, `none` means one thing: hooks that came with an installed package stop being added for it.
- Allowing a package's hooks no longer records an answer that quietly comes true later. `dorkos harness sync --fix --allow-hooks <package>` stops and explains itself when nothing in your project can take those hooks — whether that is because you told DorkOS not to write them, or because none of the agents you use has anywhere to put them. Saying yes was being saved either way, and would have installed them the day you changed that, without asking. When only some of your agents are covered it saves your answer and tells you which ones miss out.
- Four keys in that same file are no longer read by anything: `skillWrappers`, `commandMappings`, `instructionProjections` and `skillBundles`. Your file still works if it has them, and `dorkos harness sync` names each one so you can delete it. A manifest DorkOS writes for you from now on has only the three keys that do something.
