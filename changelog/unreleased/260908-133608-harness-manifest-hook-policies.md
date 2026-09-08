---
covers:
  - 'feat(harness): hook policies are honoured, four keys retire (DOR-1858)'
---

### Changed

- Your project's `.agents/harness.manifest.json` can say what to do with your hooks for each agent, and DorkOS now does what it says. `none` means that agent's hooks file is not written, and the report says so instead of quietly writing it anyway; `generate` is what DorkOS has always done; say nothing about an agent and nothing changes for it. If DorkOS had already written that file, `dorkos harness sync --fix` clears it away — and never touches one you wrote yourself.
- Four keys in that same file are no longer read by anything: `skillWrappers`, `commandMappings`, `instructionProjections` and `skillBundles`. Your file still works if it has them, and `dorkos harness sync` names each one so you can delete it. A manifest DorkOS writes for you from now on has only the three keys that do something.
