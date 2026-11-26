---
covers:
  - 'fix(api): the runtime setup reads are served by the capability mount (DOR-4978)'
---

### Changed

- Your account usage, the Claude account folders found on your computer, and which accounts may work in a project are now yours to read. An agent or a program with a key asking for them through the API is turned away. Agents still read account usage with their own usage tool.
- Whether a runtime's key is saved, your OpenCode key setup, and your DorkOS model setup are also yours alone now. A program with an API key on this computer can no longer read them.
- Asking for the usage or key of a runtime DorkOS doesn't know now gets an error that names the runtimes it accepts, instead of repeating the name you sent.
