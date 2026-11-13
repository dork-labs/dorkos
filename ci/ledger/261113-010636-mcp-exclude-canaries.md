---
id: 261113-010636
title: A Codex native row and a repo-wide copy guard pin what keep-from reaches (DOR-3837)
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.test.codex-sandbox
  - wf.typecheck.typecheck
prs: []
ratchet-release: []
field-changes: []
---

One new row in `app-server.binary.test.ts` gives a managed stdio server a
made-up env value and an HTTP server a made-up header, then reads every file
Codex wrote in the throwaway home and finds neither. One new suite,
`scripts/__tests__/mcp-exclude-copy.test.ts`, is added to `REPO_WIDE_SUITES`,
so `typecheck` reads the MCP copy for words that would promise keep-from hides
a key.

No workflow, timeout, retry, required check or permission changes. Nothing
measurable should move except about a second of job time in each.
