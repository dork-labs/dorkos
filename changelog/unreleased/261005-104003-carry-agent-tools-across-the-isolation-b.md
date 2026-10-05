---
covers:
  - 'feat(extensions): carry agent tools across the isolation boundary (DOR-2686)'
  - 'test(extensions): prove agent tools from an isolated extension with a real child (DOR-2686)'
  - 'docs(extensions): tools work from extensions that run separately (DOR-2686)'
  - 'docs(decisions): promote the isolated extension backend decisions and mark the spec implemented (DOR-2686)'
  - 'fix(extensions): close tool binding at registered, lock raw send, unlist tools on exit (DOR-2686)'
  - 'docs(extensions): say process.send is not available to an isolated extension (DOR-2686)'
---

### Added

- An extension that runs separately from DorkOS can now give your agents tools, the same way one running inside DorkOS does. Each call still goes through your permissions first, inside DorkOS. If the extension crashes or freezes, its tools disappear until it is running again, and a call that was in progress fails instead of waiting. (DOR-2686)
